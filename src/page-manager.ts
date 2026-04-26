import { promises as fs } from "node:fs";
import path from "node:path";
import { crc32 } from "./fast-binary.js";
import { WotonFileError, WotonValidationError } from "./errors.js";

export type PageSize = 4096 | 8192 | 16384;

export interface PageManagerOptions {
  readonly path: string;
  readonly pageSize?: PageSize;
  readonly cachePages?: number;
  readonly cipher?: PageCipher;
  readonly readOnly?: boolean;
}

export interface PageCipher {
  readonly overhead: number;
  encrypt(pageId: number, page: Buffer): Buffer;
  decrypt(pageId: number, payload: Buffer): Buffer;
}

export interface PageDevice {
  readonly size: PageSize;
  readonly pages: number;
  readonly cachedPages: number;
  allocatePage(): number;
  readPage(pageId: number): Promise<Buffer>;
  writePage(pageId: number, data: Buffer | Uint8Array): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface CachedPage {
  data: Buffer;
  dirty: boolean;
}

const PAGE_FILE_MAGIC = Buffer.from("WTPG", "ascii");
const PAGE_WAL_MAGIC = Buffer.from("WTPW", "ascii");
const PAGE_FILE_VERSION = 1;
const PAGE_HEADER_SIZE = 64;
const PAGE_WAL_HEADER_SIZE = PAGE_WAL_MAGIC.byteLength + 4 + 4 + 4;
const DEFAULT_PAGE_SIZE: PageSize = 8192;
const DEFAULT_CACHE_PAGES = 4096;
const VALID_PAGE_SIZES = new Set<number>([4096, 8192, 16384]);

export class PageManager {
  private readonly cache = new Map<number, CachedPage>();
  private pageCount = 0;
  private closed = false;

  private constructor(
    private readonly filePath: string,
    private readonly pageSize: PageSize,
    private readonly maxCachePages: number,
    private readonly cipher: PageCipher | undefined,
    private readonly readOnly: boolean
  ) {}

  static async open(options: PageManagerOptions): Promise<PageManager> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    assertPageSize(pageSize);

    const manager = new PageManager(
      options.path,
      pageSize,
      Math.max(1, Math.floor(options.cachePages ?? DEFAULT_CACHE_PAGES)),
      options.cipher,
      options.readOnly ?? false
    );
    await manager.openFile();
    if (!options.readOnly) {
      await manager.recoverWal();
    }
    return manager;
  }

  get size(): PageSize {
    return this.pageSize;
  }

  get pages(): number {
    return this.pageCount;
  }

  get cachedPages(): number {
    return this.cache.size;
  }

  allocatePage(): number {
    this.assertOpen();
    this.assertWritable();
    const pageId = this.pageCount;
    this.pageCount += 1;
    this.cachePage(pageId, Buffer.alloc(this.pageSize), true);
    return pageId;
  }

  async readPage(pageId: number): Promise<Buffer> {
    this.assertOpen();
    this.assertPageId(pageId);

    const cached = this.cache.get(pageId);

    if (cached) {
      this.touch(pageId, cached);
      return Buffer.from(cached.data);
    }

    const data = await this.readPageFromDisk(pageId);
    this.cachePage(pageId, data, false);
    return Buffer.from(data);
  }

  writePage(pageId: number, data: Buffer | Uint8Array): void {
    this.assertOpen();
    this.assertWritable();
    this.assertPageId(pageId);

    if (data.byteLength > this.pageSize) {
      throw new WotonValidationError(`Page payload exceeds ${this.pageSize} bytes.`);
    }

    const page = Buffer.alloc(this.pageSize);
    Buffer.from(data).copy(page, 0);
    this.cachePage(pageId, page, true);
  }

  async flush(): Promise<void> {
    this.assertOpen();

    if (this.readOnly) {
      return;
    }

    const dirty = [...this.cache.entries()].filter(([, page]) => page.dirty);

    if (dirty.length === 0) {
      await this.writeHeader();
      return;
    }

    await this.appendPageWal(dirty);
    await this.writeDirtyPages(dirty);
    await this.writeHeader();
    await fs.unlink(this.walPath).catch(() => undefined);
    await fsyncDirectory(path.dirname(this.filePath));

    for (const [, page] of dirty) {
      page.dirty = false;
    }

    this.evictCleanPages();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.flush();
    this.cache.clear();
    this.closed = true;
  }

  private async openFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    if (!(await exists(this.filePath))) {
      if (this.readOnly) {
        throw new WotonFileError("The page file does not exist.");
      }

      await this.writeHeader();
      return;
    }

    const handle = await fs.open(this.filePath, "r");
    try {
      const header = Buffer.alloc(PAGE_HEADER_SIZE);
      const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);

      if (bytesRead !== PAGE_HEADER_SIZE || !header.subarray(0, 4).equals(PAGE_FILE_MAGIC)) {
        throw new WotonFileError("The page file format is not supported.");
      }

      const version = header.readUInt32LE(4);
      const pageSize = header.readUInt32LE(8);

      if (version !== PAGE_FILE_VERSION || pageSize !== this.pageSize) {
        throw new WotonFileError("The page file settings are not supported.");
      }

      this.pageCount = header.readUInt32LE(12);
    } finally {
      await handle.close();
    }
  }

  private async writeHeader(): Promise<void> {
    const header = Buffer.alloc(PAGE_HEADER_SIZE);
    PAGE_FILE_MAGIC.copy(header, 0);
    header.writeUInt32LE(PAGE_FILE_VERSION, 4);
    header.writeUInt32LE(this.pageSize, 8);
    header.writeUInt32LE(this.pageCount, 12);

    const handle = await fs.open(this.filePath, (await exists(this.filePath)) ? "r+" : "w+");
    try {
      await handle.write(header, 0, header.byteLength, 0);
      await handle.datasync().catch(() => handle.sync());
    } finally {
      await handle.close();
    }
  }

  private async readPageFromDisk(pageId: number): Promise<Buffer> {
    const pageOffset = this.pageOffset(pageId);
    const record = Buffer.alloc(this.pageRecordSize);
    const handle = await fs.open(this.filePath, "r");
    try {
      const { bytesRead } = await handle.read(record, 0, record.byteLength, pageOffset);

      if (bytesRead === 0) {
        return Buffer.alloc(this.pageSize);
      }

      if (bytesRead !== record.byteLength) {
        throw new WotonFileError("The page file contains a truncated page.");
      }
    } finally {
      await handle.close();
    }

    const payload = record.subarray(4);
    const expectedChecksum = record.readUInt32LE(0);

    if (crc32(payload) !== expectedChecksum) {
      throw new WotonFileError("The page checksum is invalid.");
    }

    const data = this.cipher ? this.cipher.decrypt(pageId, payload) : payload;

    if (data.byteLength !== this.pageSize) {
      throw new WotonFileError("The page payload has an invalid size.");
    }

    return Buffer.from(data);
  }

  private async appendPageWal(entries: Array<[number, CachedPage]>): Promise<void> {
    const handle = await fs.open(this.walPath, "a");
    try {
      for (const [pageId, page] of entries) {
        await handle.writeFile(encodePageWalRecord(pageId, page.data, this.cipher));
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeDirtyPages(entries: Array<[number, CachedPage]>): Promise<void> {
    const handle = await fs.open(this.filePath, "r+");
    try {
      for (const [pageId, page] of entries) {
        const record = this.pageRecord(pageId, page.data);
        await handle.write(record, 0, record.byteLength, this.pageOffset(pageId));
      }
      await handle.datasync().catch(() => handle.sync());
    } finally {
      await handle.close();
    }
  }

  private async recoverWal(): Promise<void> {
    if (!(await exists(this.walPath))) {
      return;
    }

    const bytes = await fs.readFile(this.walPath);
    const recovered: Array<[number, Buffer]> = [];
    let offset = 0;

    while (offset < bytes.byteLength) {
      if (bytes.byteLength - offset < PAGE_WAL_HEADER_SIZE) {
        break;
      }

      if (!bytes.subarray(offset, offset + PAGE_WAL_MAGIC.byteLength).equals(PAGE_WAL_MAGIC)) {
        const nextMagic = bytes.indexOf(PAGE_WAL_MAGIC, offset + 1);

        if (nextMagic === -1) {
          break;
        }

        throw new WotonFileError("The page WAL contains a corrupted record before the end of the file.");
      }

      const pageId = bytes.readUInt32LE(offset + PAGE_WAL_MAGIC.byteLength);
      const payloadLength = bytes.readUInt32LE(offset + PAGE_WAL_MAGIC.byteLength + 4);
      const expectedChecksum = bytes.readUInt32LE(offset + PAGE_WAL_MAGIC.byteLength + 8);
      const payloadOffset = offset + PAGE_WAL_HEADER_SIZE;
      const nextOffset = payloadOffset + payloadLength;

      if (payloadLength !== this.pagePayloadSize || nextOffset > bytes.byteLength) {
        const nextMagic = bytes.indexOf(PAGE_WAL_MAGIC, offset + 1);

        if (nextMagic !== -1) {
          throw new WotonFileError("The page WAL contains a corrupted record before the end of the file.");
        }

        break;
      }

      const payload = bytes.subarray(payloadOffset, nextOffset);

      if (crc32(payload) !== expectedChecksum) {
        const nextMagic = bytes.indexOf(PAGE_WAL_MAGIC, offset + 1);

        if (nextMagic !== -1) {
          throw new WotonFileError("The page WAL contains a corrupted record before the end of the file.");
        }

        break;
      }

      recovered.push([pageId, this.cipher ? this.cipher.decrypt(pageId, payload) : Buffer.from(payload)]);
      this.pageCount = Math.max(this.pageCount, pageId + 1);
      offset = nextOffset;
    }

    if (recovered.length > 0) {
      await this.writeDirtyPages(recovered.map(([pageId, data]) => [pageId, { data, dirty: true }]));
      await this.writeHeader();
    }

    await fs.unlink(this.walPath).catch(() => undefined);
    await fsyncDirectory(path.dirname(this.walPath));
  }

  private pageOffset(pageId: number): number {
    return PAGE_HEADER_SIZE + pageId * this.pageRecordSize;
  }

  private get pagePayloadSize(): number {
    return this.pageSize + (this.cipher?.overhead ?? 0);
  }

  private get pageRecordSize(): number {
    return this.pagePayloadSize + 4;
  }

  private pageRecord(pageId: number, page: Buffer): Buffer {
    const payload = this.cipher ? this.cipher.encrypt(pageId, page) : page;
    const checksum = Buffer.allocUnsafe(4);
    checksum.writeUInt32LE(crc32(payload), 0);
    return Buffer.concat([checksum, payload]);
  }

  private cachePage(pageId: number, data: Buffer, dirty: boolean): void {
    this.cache.set(pageId, { data, dirty });
    this.evictCleanPages();
  }

  private touch(pageId: number, page: CachedPage): void {
    this.cache.delete(pageId);
    this.cache.set(pageId, page);
  }

  private evictCleanPages(): void {
    while (this.cache.size > this.maxCachePages) {
      const oldest = this.cache.entries().next().value as [number, CachedPage] | undefined;

      if (!oldest) {
        return;
      }

      if (oldest[1].dirty) {
        return;
      }

      this.cache.delete(oldest[0]);
    }
  }

  private get walPath(): string {
    return `${this.filePath}-pwal`;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WotonFileError("The page manager is already closed.");
    }
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new WotonFileError("The page manager is read-only.");
    }
  }

  private assertPageId(pageId: number): void {
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= this.pageCount) {
      throw new WotonValidationError(`Invalid page id: ${pageId}.`);
    }
  }
}

export function encodePageWalRecord(pageId: number, page: Buffer, cipher?: PageCipher): Buffer {
  const payload = cipher ? cipher.encrypt(pageId, page) : page;
  const header = Buffer.allocUnsafe(PAGE_WAL_HEADER_SIZE);
  PAGE_WAL_MAGIC.copy(header, 0);
  header.writeUInt32LE(pageId, PAGE_WAL_MAGIC.byteLength);
  header.writeUInt32LE(payload.byteLength, PAGE_WAL_MAGIC.byteLength + 4);
  header.writeUInt32LE(crc32(payload), PAGE_WAL_MAGIC.byteLength + 8);
  return Buffer.concat([header, payload]);
}

function assertPageSize(pageSize: number): asserts pageSize is PageSize {
  if (!VALID_PAGE_SIZES.has(pageSize)) {
    throw new WotonValidationError("Page size must be 4096, 8192, or 16384 bytes.");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
