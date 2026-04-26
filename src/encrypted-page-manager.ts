import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { destroyEncryptionKey, type EncryptionKey } from "./crypto.js";
import { WotonSecurityError, WotonValidationError } from "./errors.js";
import { openKeyFile } from "./key-file.js";
import { PageManager, type PageCipher, type PageDevice, type PageSize } from "./page-manager.js";

export interface EncryptedPageManagerOptions {
  readonly path: string;
  readonly password: string | Buffer;
  readonly pageSize?: PageSize;
  readonly cachePages?: number;
  readonly minPasswordLength?: number;
  readonly readOnly?: boolean;
}

const PAGE_KEY_MAGIC = Buffer.from("WTPK", "ascii");
const PAGE_AAD_MAGIC = Buffer.from("WTPA", "ascii");
const DEFAULT_MIN_PASSWORD_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class EncryptedPageManager implements PageDevice {
  private closed = false;

  private constructor(
    private readonly manager: PageManager,
    private readonly encryptionKey: EncryptionKey
  ) {}

  static async open(options: EncryptedPageManagerOptions): Promise<EncryptedPageManager> {
    const encryptionKey = await openKeyFile({
      path: `${options.path}-pkey`,
      magic: PAGE_KEY_MAGIC,
      password: options.password,
      minPasswordLength: options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH
    });

    try {
      const manager = await PageManager.open({
        path: options.path,
        pageSize: options.pageSize,
        cachePages: options.cachePages,
        cipher: new AesGcmPageCipher(encryptionKey.key),
        readOnly: options.readOnly
      });

      return new EncryptedPageManager(manager, encryptionKey);
    } catch (error) {
      destroyEncryptionKey(encryptionKey);
      throw error;
    }
  }

  get size(): PageSize {
    return this.manager.size;
  }

  get pages(): number {
    return this.manager.pages;
  }

  get cachedPages(): number {
    return this.manager.cachedPages;
  }

  allocatePage(): number {
    return this.manager.allocatePage();
  }

  readPage(pageId: number): Promise<Buffer> {
    return this.manager.readPage(pageId);
  }

  writePage(pageId: number, data: Buffer | Uint8Array): void {
    this.manager.writePage(pageId, data);
  }

  flush(): Promise<void> {
    return this.manager.flush();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.manager.close();
    } finally {
      destroyEncryptionKey(this.encryptionKey);
      this.closed = true;
    }
  }
}

class AesGcmPageCipher implements PageCipher {
  readonly overhead = IV_LENGTH + TAG_LENGTH;

  constructor(private readonly key: Buffer) {}

  encrypt(pageId: number, page: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(pageAad(pageId));
    const encrypted = cipher.update(page);
    const final = cipher.final();
    const tag = cipher.getAuthTag();

    return final.byteLength === 0
      ? Buffer.concat([iv, tag, encrypted], this.overhead + encrypted.byteLength)
      : Buffer.concat([iv, tag, encrypted, final], this.overhead + encrypted.byteLength + final.byteLength);
  }

  decrypt(pageId: number, payload: Buffer): Buffer {
    if (payload.byteLength < this.overhead) {
      throw new WotonSecurityError("The encrypted page payload is truncated.");
    }

    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(pageAad(pageId));
    decipher.setAuthTag(tag);

    try {
      const decrypted = decipher.update(encrypted);
      const final = decipher.final();
      return final.byteLength === 0 ? decrypted : Buffer.concat([decrypted, final]);
    } catch (error) {
      throw new WotonSecurityError("Could not decrypt the page payload.", { cause: error });
    }
  }
}

function pageAad(pageId: number): Buffer {
  if (!Number.isInteger(pageId) || pageId < 0 || pageId > 0xffffffff) {
    throw new WotonValidationError(`Invalid page id: ${pageId}.`);
  }

  const bytes = Buffer.allocUnsafe(8);
  PAGE_AAD_MAGIC.copy(bytes, 0);
  bytes.writeUInt32LE(pageId, 4);
  return bytes;
}
