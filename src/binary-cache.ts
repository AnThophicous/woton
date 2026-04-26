import { promises as fs } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { destroyEncryptionKey, type EncryptionKey } from "./crypto.js";
import { WotonSecurityError } from "./errors.js";
import { crc32, fnv1a32 } from "./fast-binary.js";
import { openKeyFile } from "./key-file.js";

export interface BinaryCacheEntry {
  readonly queryHash: number;
  readonly pageId: number;
  readonly slot: number;
  readonly checksum: number;
  readonly flags: number;
}

export interface BinaryCacheOptions {
  readonly path: string;
  readonly password?: string | Buffer;
  readonly minPasswordLength?: number;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly compactAfterAppends?: number;
}

const ENTRY_SIZE = 20;
const ENTRY_ACTIVE = 1;
const DEFAULT_MIN_PASSWORD_LENGTH = 16;
const CACHE_KEY_MAGIC = Buffer.from("WTBK", "ascii");
const CACHE_RECORD_MAGIC = Buffer.from("WBC1", "ascii");
const CACHE_RECORD_AAD = Buffer.from("Woton.BinaryCache.v1", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENCRYPTED_ENTRY_SIZE = CACHE_RECORD_MAGIC.byteLength + 4 + IV_LENGTH + TAG_LENGTH + ENTRY_SIZE;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024;
const DEFAULT_MAX_ENTRIES = 256;

export class BinaryCache {
  private readonly entries = new Map<number, BinaryCacheEntry>();
  private appendedEntries = 0;
  private closed = false;

  private constructor(
    private readonly filePath: string,
    private readonly cipher: BinaryCacheCipher | undefined,
    private readonly maxEntries: number,
    private readonly maxFileBytes: number,
    private readonly compactAfterAppends: number
  ) {}

  static async open(options: BinaryCacheOptions): Promise<BinaryCache> {
    let encryptionKey: EncryptionKey | undefined;

    try {
      encryptionKey = options.password
        ? await openKeyFile({
          path: `${options.path}-bkey`,
          magic: CACHE_KEY_MAGIC,
          password: options.password,
          minPasswordLength: options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH
        })
        : undefined;

      const cipher = encryptionKey ? new AesGcmBinaryCacheCipher(encryptionKey) : undefined;
      const entryBytes = cipher?.entrySize ?? ENTRY_SIZE;
      const maxFileBytes = Math.max(entryBytes, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
      const maxEntriesByFile = Math.max(1, Math.floor(maxFileBytes / entryBytes));
      const maxEntries = Math.max(
        1,
        Math.min(Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES), maxEntriesByFile)
      );
      const cache = new BinaryCache(
        options.path,
        cipher,
        maxEntries,
        maxFileBytes,
        Math.max(1, Math.floor(options.compactAfterAppends ?? maxEntries * 2))
      );
      await cache.load();
      return cache;
    } catch (error) {
      destroyEncryptionKey(encryptionKey);
      throw error;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get entryBytes(): number {
    return this.cipher?.entrySize ?? ENTRY_SIZE;
  }

  get maxEntryCount(): number {
    return this.maxEntries;
  }

  get(queryHash: number): BinaryCacheEntry | undefined {
    this.assertOpen();
    return this.entries.get(queryHash >>> 0);
  }

  async put(entry: Omit<BinaryCacheEntry, "flags"> & { readonly flags?: number }): Promise<void> {
    this.assertOpen();
    const normalized: BinaryCacheEntry = {
      queryHash: entry.queryHash >>> 0,
      pageId: entry.pageId >>> 0,
      slot: entry.slot >>> 0,
      checksum: entry.checksum >>> 0,
      flags: entry.flags ?? ENTRY_ACTIVE
    };

    if (!this.entries.has(normalized.queryHash) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as number | undefined;

      if (oldest !== undefined) {
        await this.delete(oldest);
      }
    }

    this.entries.delete(normalized.queryHash);
    this.entries.set(normalized.queryHash, normalized);
    await this.append(normalized);
    await this.enforceBudget();
  }

  async delete(queryHash: number): Promise<boolean> {
    this.assertOpen();
    const normalizedHash = queryHash >>> 0;
    const existed = this.entries.delete(normalizedHash);

    if (existed) {
      await this.append({
        queryHash: normalizedHash,
        pageId: 0,
        slot: 0,
        checksum: 0,
        flags: 0
      });
      await this.enforceBudget();
    }

    return existed;
  }

  async compact(): Promise<void> {
    this.assertOpen();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const entrySize = this.cipher?.entrySize ?? ENTRY_SIZE;
    const bytes = Buffer.allocUnsafe(this.entries.size * entrySize);
    let offset = 0;

    for (const entry of this.entries.values()) {
      this.encodeStoredEntry(entry).copy(bytes, offset);
      offset += entrySize;
    }

    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, this.filePath);
    this.appendedEntries = 0;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.entries.clear();
    this.cipher?.close();
    this.closed = true;
  }

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    let bytes: Buffer;

    try {
      bytes = await fs.readFile(this.filePath);
    } catch {
      return;
    }

    const entrySize = this.cipher?.entrySize ?? ENTRY_SIZE;
    const fullLength = bytes.byteLength - (bytes.byteLength % entrySize);

    for (let offset = 0; offset < fullLength; offset += entrySize) {
      let entry: BinaryCacheEntry | undefined;

      try {
        entry = this.decodeStoredEntry(bytes, offset);
      } catch {
        this.entries.clear();
        return;
      }

      if (!entry) {
        this.entries.clear();
        return;
      }

      if (entry.flags === 0) {
        this.entries.delete(entry.queryHash);
      } else {
        this.entries.set(entry.queryHash, entry);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as number | undefined;

      if (oldest === undefined) {
        break;
      }

      this.entries.delete(oldest);
    }

    if (bytes.byteLength > this.maxFileBytes || fullLength !== bytes.byteLength) {
      await this.compact();
    }
  }

  private async append(entry: BinaryCacheEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, this.encodeStoredEntry(entry));
    this.appendedEntries += 1;
  }

  private async enforceBudget(): Promise<void> {
    if (this.appendedEntries >= this.compactAfterAppends) {
      await this.compact();
      return;
    }

    const size = await fs.stat(this.filePath).then((stat) => stat.size, () => 0);

    if (size > this.maxFileBytes) {
      await this.compact();
    }
  }

  private encodeStoredEntry(entry: BinaryCacheEntry): Buffer {
    const encoded = encodeEntry(entry);
    return this.cipher ? this.cipher.encrypt(encoded) : encoded;
  }

  private decodeStoredEntry(bytes: Buffer, offset: number): BinaryCacheEntry | undefined {
    if (!this.cipher) {
      return decodeEntry(bytes, offset);
    }

    const decoded = this.cipher.decrypt(bytes.subarray(offset, offset + this.cipher.entrySize));
    return decoded ? decodeEntry(decoded, 0) : undefined;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("The binary cache is already closed.");
    }
  }
}

interface BinaryCacheCipher {
  readonly entrySize: number;
  encrypt(entry: Buffer): Buffer;
  decrypt(record: Buffer): Buffer | undefined;
  close(): void;
}

class AesGcmBinaryCacheCipher implements BinaryCacheCipher {
  readonly entrySize = ENCRYPTED_ENTRY_SIZE;

  constructor(private readonly encryptionKey: EncryptionKey) {}

  encrypt(entry: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey.key, iv);
    cipher.setAAD(CACHE_RECORD_AAD);
    const encrypted = cipher.update(entry);
    const final = cipher.final();
    const tag = cipher.getAuthTag();
    const record = Buffer.allocUnsafe(this.entrySize);
    let offset = 0;

    CACHE_RECORD_MAGIC.copy(record, offset);
    offset += CACHE_RECORD_MAGIC.byteLength;
    offset += 4;
    iv.copy(record, offset);
    offset += IV_LENGTH;
    tag.copy(record, offset);
    offset += TAG_LENGTH;
    encrypted.copy(record, offset);
    offset += encrypted.byteLength;

    if (final.byteLength > 0) {
      final.copy(record, offset);
    }

    record.writeUInt32LE(crc32(record.subarray(CACHE_RECORD_MAGIC.byteLength + 4)), CACHE_RECORD_MAGIC.byteLength);
    return record;
  }

  decrypt(record: Buffer): Buffer | undefined {
    if (record.byteLength !== this.entrySize || !record.subarray(0, 4).equals(CACHE_RECORD_MAGIC)) {
      return undefined;
    }

    const expectedChecksum = record.readUInt32LE(CACHE_RECORD_MAGIC.byteLength);
    const checksummed = record.subarray(CACHE_RECORD_MAGIC.byteLength + 4);

    if (crc32(checksummed) !== expectedChecksum) {
      return undefined;
    }

    const iv = record.subarray(8, 8 + IV_LENGTH);
    const tag = record.subarray(8 + IV_LENGTH, 8 + IV_LENGTH + TAG_LENGTH);
    const encrypted = record.subarray(8 + IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey.key, iv);
    decipher.setAAD(CACHE_RECORD_AAD);
    decipher.setAuthTag(tag);

    try {
      const decrypted = decipher.update(encrypted);
      const final = decipher.final();
      return final.byteLength === 0 ? decrypted : Buffer.concat([decrypted, final]);
    } catch (error) {
      throw new WotonSecurityError("Could not decrypt the binary cache entry.", { cause: error });
    }
  }

  close(): void {
    destroyEncryptionKey(this.encryptionKey);
  }
}

export function equalityQueryHash(collection: string, field: string, value: string | number | boolean | null): number {
  return fnv1a32(Buffer.from(normalizeEqualityQuery(collection, field, value), "utf8"));
}

export function normalizeEqualityQuery(collection: string, field: string, value: string | number | boolean | null): string {
  const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : String(value);
  return `${collection.trim().toLowerCase()}:${field.trim().toLowerCase()}=${normalizedValue}`;
}

function encodeEntry(entry: BinaryCacheEntry): Buffer {
  const bytes = Buffer.allocUnsafe(ENTRY_SIZE);
  bytes.writeUInt32LE(entry.queryHash >>> 0, 0);
  bytes.writeUInt32LE(entry.pageId >>> 0, 4);
  bytes.writeUInt32LE(entry.slot >>> 0, 8);
  bytes.writeUInt32LE(entry.checksum >>> 0, 12);
  bytes.writeUInt32LE(entry.flags >>> 0, 16);
  return bytes;
}

function decodeEntry(bytes: Buffer, offset: number): BinaryCacheEntry {
  return {
    queryHash: bytes.readUInt32LE(offset),
    pageId: bytes.readUInt32LE(offset + 4),
    slot: bytes.readUInt32LE(offset + 8),
    checksum: bytes.readUInt32LE(offset + 12),
    flags: bytes.readUInt32LE(offset + 16)
  };
}
