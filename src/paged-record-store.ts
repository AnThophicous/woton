import { BinaryCache, equalityQueryHash } from "./binary-cache.js";
import { decodeRecord, encodeRecord } from "./binary-codec.js";
import { EncryptedPageManager } from "./encrypted-page-manager.js";
import { crc32, fnv1a32 } from "./fast-binary.js";
import { PagedBTree, type BTreePointerValue } from "./paged-btree.js";
import { PageManager, type PageDevice, type PageSize } from "./page-manager.js";
import { getByPath } from "./query-engine.js";
import { WotonFileError, WotonValidationError } from "./errors.js";
import { WotonConnectedWorker, type WcwOptions, type WcwStats } from "./wcw.js";
import type { WotonPrimitive, WotonRecord, WotonValue } from "./types.js";

export interface PagedRecordStoreOptions {
  readonly path: string;
  readonly pageSize?: PageSize;
  readonly cachePages?: number;
  readonly encryptionPassword?: string | Buffer;
  readonly minPasswordLength?: number;
  readonly binaryCachePath?: string | false;
  readonly binaryCacheMaxEntries?: number;
  readonly binaryCacheMaxFileBytes?: number;
  readonly wcw?: boolean | Omit<WcwOptions, "database" | "cache" | "recordCount" | "onPointer">;
}

export interface PagedRecordPointer {
  readonly pageId: number;
  readonly slot: number;
  readonly checksum: number;
}

export interface PagedRecordEntry<T extends object = object> {
  readonly collection: string;
  readonly record: WotonRecord<T>;
  readonly pointer: PagedRecordPointer;
}

export interface PagedEqualityScanOptions {
  readonly path: string;
  readonly pageSize?: PageSize;
  readonly cachePages?: number;
  readonly encryptionPassword?: string | Buffer;
  readonly minPasswordLength?: number;
  readonly maxPages?: number;
}

export interface PagedEqualityScanQuery {
  readonly collection: string;
  readonly field: string;
  readonly value: WotonPrimitive;
}

export interface PagedEqualityScanResult {
  readonly pointer?: PagedRecordPointer;
  readonly scannedPages: number;
  readonly scannedRecords: number;
}

const RECORD_PAGE_MAGIC = Buffer.from("WTRD", "ascii");
const RECORD_PAGE_VERSION = 1;
const RECORD_PAGE_HEADER_SIZE = 16;
const SLOT_SIZE = 8;
const EMPTY_U16 = 0xffff;

export class PagedRecordStore {
  private readonly counts = new Map<string, number>();
  private wcw: WotonConnectedWorker | undefined;
  private closed = false;

  private constructor(
    private readonly pages: PageDevice,
    private readonly idIndex: PagedBTree,
    private readonly binaryCache: BinaryCache | undefined
  ) {}

  static async open(options: PagedRecordStoreOptions): Promise<PagedRecordStore> {
    const store = new PagedRecordStore(
      await openPageDevice(options),
      await PagedBTree.open({
        path: `${options.path}-rid`,
        pageSize: options.pageSize,
        cachePages: options.cachePages,
        encryptionPassword: options.encryptionPassword,
        minPasswordLength: options.minPasswordLength
      }),
      options.binaryCachePath === false
        ? undefined
        : await BinaryCache.open({
          path: options.binaryCachePath ?? `${options.path}-bc`,
          password: options.encryptionPassword,
          minPasswordLength: options.minPasswordLength,
          maxEntries: options.binaryCacheMaxEntries,
          maxFileBytes: options.binaryCacheMaxFileBytes
        })
    );
    await store.rebuildIndex();
    store.openConnectedWorker(options);
    return store;
  }

  get pageSize(): PageSize {
    return this.pages.size;
  }

  get pageCount(): number {
    return this.pages.pages;
  }

  get cachedPages(): number {
    return this.pages.cachedPages;
  }

  get binaryCacheSize(): number {
    return this.binaryCache?.size ?? 0;
  }

  connectedWorkerStats(): WcwStats | undefined {
    return this.wcw?.stats();
  }

  count(collection: string): number {
    return this.counts.get(collection) ?? 0;
  }

  async has(collection: string, id: string): Promise<boolean> {
    return Boolean(await this.idIndex.get(recordKey(collection, id)));
  }

  async get<T extends object>(collection: string, id: string): Promise<WotonRecord<T> | null> {
    this.assertOpen();
    const pointer = await this.idIndex.get(recordKey(collection, id));

    if (!pointer) {
      return null;
    }

    const decoded = await this.readPointer<T>(pointer);

    if (!decoded) {
      await this.idIndex.delete(recordKey(collection, id));
      return null;
    }

    return decoded.collection === collection && decoded.record.id === id
      ? decoded.record as WotonRecord<T>
      : null;
  }

  async put<T extends object>(collection: string, record: WotonRecord<T>): Promise<PagedRecordPointer> {
    this.assertOpen();
    assertRecordFits(record, collection, this.pages.size);

    const key = recordKey(collection, record.id);
    const previous = await this.idIndex.get(key);

    if (previous) {
      await this.markDeleted(previous);
    } else {
      this.counts.set(collection, this.count(collection) + 1);
    }

    const packed = packRecord(collection, record);
    const pointer = await this.insertPacked(packed, record.id);
    await this.idIndex.set(key, pointer);
    return pointer;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    this.assertOpen();
    const key = recordKey(collection, id);
    const pointer = await this.idIndex.get(key);

    if (!pointer) {
      return false;
    }

    await this.markDeleted(pointer);
    await this.idIndex.delete(key);
    this.counts.set(collection, Math.max(0, this.count(collection) - 1));
    return true;
  }

  async *records<T extends object>(collection?: string): AsyncIterable<WotonRecord<T>> {
    for await (const entry of this.entries<T>(collection)) {
      yield entry.record;
    }
  }

  async *entries<T extends object>(collection?: string): AsyncIterable<PagedRecordEntry<T>> {
    this.assertOpen();

    for (let pageId = 0; pageId < this.pages.pages; pageId += 1) {
      const page = await this.pages.readPage(pageId);

      if (!isRecordPage(page)) {
        continue;
      }

      const slotCount = page.readUInt16LE(6);

      for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
        const slot = readSlot(page, slotIndex);

        if (slot.length === 0 || slot.offset === EMPTY_U16 || slot.hash === 0) {
          continue;
        }

        const decoded = unpackRecord(page.subarray(slot.offset, slot.offset + slot.length));

        if (collection === undefined || decoded.collection === collection) {
          yield {
            collection: decoded.collection,
            record: decoded.record as WotonRecord<T>,
            pointer: {
              pageId,
              slot: slotIndex,
              checksum: crc32(page.subarray(slot.offset, slot.offset + slot.length))
            }
          };
        }
      }
    }
  }

  async getCachedEquality<T extends object>(
    collection: string,
    field: string,
    value: WotonPrimitive
  ): Promise<WotonRecord<T> | null> {
    this.assertOpen();

    if (!this.binaryCache) {
      return null;
    }

    const queryHash = equalityQueryHash(collection, field, value);
    const entry = this.binaryCache.get(queryHash);

    if (!entry) {
      return null;
    }

    const decoded = await this.readPointer<T>(entry);

    if (
      decoded &&
      decoded.collection === collection &&
      primitiveValuesEqual(getByPath(decoded.record, field), value)
    ) {
      return decoded.record;
    }

    await this.binaryCache.delete(queryHash);
    return null;
  }

  async warmEquality(collection: string, field: string, value: WotonPrimitive): Promise<PagedRecordPointer | null> {
    this.assertOpen();
    const queryHash = equalityQueryHash(collection, field, value);

    for await (const entry of this.entries(collection)) {
      if (!primitiveValuesEqual(getByPath(entry.record, field), value)) {
        continue;
      }

      await this.binaryCache?.put({
        queryHash,
        pageId: entry.pointer.pageId,
        slot: entry.pointer.slot,
        checksum: entry.pointer.checksum
      });
      return entry.pointer;
    }

    await this.binaryCache?.delete(queryHash);
    return null;
  }

  async findFirstByEquality<T extends object>(
    collection: string,
    field: string,
    value: WotonPrimitive
  ): Promise<WotonRecord<T> | null> {
    const cached = await this.getCachedEquality<T>(collection, field, value);

    if (cached) {
      return cached;
    }

    if (this.wcw) {
      this.observeEqualityQuery(collection, field, value);
      return this.findFirstByScan<T>(collection, field, value);
    }

    const pointer = await this.warmEquality(collection, field, value);

    if (!pointer) {
      return null;
    }

    if (!this.binaryCache) {
      return (await this.readPointer<T>(pointer))?.record ?? null;
    }

    return this.getCachedEquality<T>(collection, field, value);
  }

  observeEqualityQuery(collection: string, field: string, value: WotonPrimitive): void {
    this.assertOpen();
    this.wcw?.recordEquality({ collection, field, value });
  }

  async waitForConnectedWorkers(): Promise<void> {
    await this.wcw?.idle();
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.idIndex.flush();
    await this.pages.flush();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.counts.clear();
    await this.wcw?.close();
    await this.binaryCache?.close();
    await this.idIndex.close();
    await this.pages.close();
    this.closed = true;
  }

  private openConnectedWorker(options: PagedRecordStoreOptions): void {
    if (!this.binaryCache || options.wcw === false) {
      return;
    }

    const wcwOptions = options.wcw === true || options.wcw === undefined ? {} : options.wcw;
    this.wcw = new WotonConnectedWorker({
      ...wcwOptions,
      database: {
        path: options.path,
        pageSize: options.pageSize,
        cachePages: Math.min(8, options.cachePages ?? 8),
        encryptionPassword: options.encryptionPassword,
        minPasswordLength: options.minPasswordLength
      },
      cache: this.binaryCache,
      recordCount: () => this.totalRecords(),
      onPointer: (query, pointer) => this.cacheWorkerPointer(query, pointer)
    });
  }

  private totalRecords(): number {
    let total = 0;

    for (const count of this.counts.values()) {
      total += count;
    }

    return total;
  }

  private async cacheWorkerPointer(query: PagedEqualityScanQuery, pointer: PagedRecordPointer): Promise<boolean> {
    const decoded = await this.readPointer(pointer);

    if (
      !decoded ||
      decoded.collection !== query.collection ||
      !primitiveValuesEqual(getByPath(decoded.record, query.field), query.value)
    ) {
      return false;
    }

    await this.binaryCache?.put({
      queryHash: equalityQueryHash(query.collection, query.field, query.value),
      pageId: pointer.pageId,
      slot: pointer.slot,
      checksum: pointer.checksum
    });
    return true;
  }

  private async findFirstByScan<T extends object>(
    collection: string,
    field: string,
    value: WotonPrimitive
  ): Promise<WotonRecord<T> | null> {
    for await (const entry of this.entries<T>(collection)) {
      if (primitiveValuesEqual(getByPath(entry.record, field), value)) {
        return entry.record;
      }
    }

    return null;
  }

  private async readPointer<T extends object>(
    pointer: PagedRecordPointer
  ): Promise<{ readonly collection: string; readonly record: WotonRecord<T> } | undefined> {
    if (pointer.pageId >= this.pages.pages) {
      return undefined;
    }

    const page = await this.pages.readPage(pointer.pageId);

    if (!isRecordPage(page)) {
      return undefined;
    }

    const slotCount = page.readUInt16LE(6);

    if (pointer.slot >= slotCount) {
      return undefined;
    }

    const slot = readSlot(page, pointer.slot);

    if (slot.length === 0 || slot.offset === EMPTY_U16 || slot.hash === 0) {
      return undefined;
    }

    const packed = page.subarray(slot.offset, slot.offset + slot.length);

    if (crc32(packed) !== pointer.checksum) {
      return undefined;
    }

    const decoded = unpackRecord(packed);

    return {
      collection: decoded.collection,
      record: decoded.record as WotonRecord<T>
    };
  }

  private async rebuildIndex(): Promise<void> {
    this.counts.clear();

    for (let pageId = 0; pageId < this.pages.pages; pageId += 1) {
      const page = await this.pages.readPage(pageId);

      if (!isRecordPage(page)) {
        continue;
      }

      const slotCount = page.readUInt16LE(6);

      for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
        const slot = readSlot(page, slotIndex);

        if (slot.length === 0 || slot.offset === EMPTY_U16 || slot.hash === 0) {
          continue;
        }

        const decoded = unpackRecord(page.subarray(slot.offset, slot.offset + slot.length));
        const key = recordKey(decoded.collection, decoded.record.id);

        await this.idIndex.set(key, {
          pageId,
          slot: slotIndex,
          checksum: crc32(page.subarray(slot.offset, slot.offset + slot.length))
        });
        this.counts.set(decoded.collection, this.count(decoded.collection) + 1);
      }
    }
  }

  private async insertPacked(packed: Buffer, id: string): Promise<PagedRecordPointer> {
    for (let pageId = 0; pageId < this.pages.pages; pageId += 1) {
      const page = await this.pages.readPage(pageId);

      if (!isRecordPage(page)) {
        continue;
      }

      const reusableSlot = findReusableSlot(page, packed.byteLength);

      if (reusableSlot !== undefined) {
        const slot = readSlot(page, reusableSlot);
        packed.copy(page, slot.offset);
        writeSlot(page, reusableSlot, {
          offset: slot.offset,
          length: packed.byteLength,
          hash: fnv1a32(Buffer.from(id))
        });
        this.pages.writePage(pageId, page);
        return { pageId, slot: reusableSlot, checksum: crc32(packed) };
      }

      if (pageFreeBytes(page) >= packed.byteLength + SLOT_SIZE) {
        const slot = writePackedToPage(page, packed, id);
        this.pages.writePage(pageId, page);
        return { pageId, slot, checksum: crc32(packed) };
      }
    }

    const pageId = this.pages.allocatePage();
    const page = emptyRecordPage(this.pages.size);
    const slot = writePackedToPage(page, packed, id);
    this.pages.writePage(pageId, page);
    return { pageId, slot, checksum: crc32(packed) };
  }

  private async markDeleted(pointer: BTreePointerValue): Promise<void> {
    const page = await this.pages.readPage(pointer.pageId);
    const slot = readSlot(page, pointer.slot);
    writeSlot(page, pointer.slot, { ...slot, hash: 0 });
    this.pages.writePage(pointer.pageId, page);
  }

  async vacuum(): Promise<void> {
    this.assertOpen();
    this.counts.clear();

    for (let pageId = 0; pageId < this.pages.pages; pageId += 1) {
      const page = await this.pages.readPage(pageId);

      if (!isRecordPage(page)) {
        continue;
      }

      const live: Array<{ readonly collection: string; readonly record: WotonRecord }> = [];
      const slotCount = page.readUInt16LE(6);

      for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
        const slot = readSlot(page, slotIndex);

        if (slot.length === 0 || slot.offset === EMPTY_U16 || slot.hash === 0) {
          continue;
        }

        live.push(unpackRecord(page.subarray(slot.offset, slot.offset + slot.length)));
      }

      const compacted = emptyRecordPage(this.pages.size);

      for (const { collection, record } of live) {
        const packed = packRecord(collection, record);
        const slot = writePackedToPage(compacted, packed, record.id);
        await this.idIndex.set(recordKey(collection, record.id), {
          pageId,
          slot,
          checksum: crc32(packed)
        });
        this.counts.set(collection, this.count(collection) + 1);
      }

      this.pages.writePage(pageId, compacted);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WotonFileError("The paged record store is already closed.");
    }
  }
}

function emptyRecordPage(pageSize: number): Buffer {
  const page = Buffer.alloc(pageSize);
  RECORD_PAGE_MAGIC.copy(page, 0);
  page.writeUInt16LE(RECORD_PAGE_VERSION, 4);
  page.writeUInt16LE(0, 6);
  page.writeUInt16LE(RECORD_PAGE_HEADER_SIZE, 8);
  page.writeUInt16LE(pageSize, 10);
  return page;
}

function isRecordPage(page: Buffer): boolean {
  return page.subarray(0, RECORD_PAGE_MAGIC.byteLength).equals(RECORD_PAGE_MAGIC);
}

function pageFreeBytes(page: Buffer): number {
  const freeStart = page.readUInt16LE(8);
  const freeEnd = page.readUInt16LE(10);
  return freeEnd - freeStart;
}

function writePackedToPage(page: Buffer, packed: Buffer, id: string): number {
  const reusableSlot = findReusableSlot(page, packed.byteLength);

  if (reusableSlot !== undefined) {
    const slot = readSlot(page, reusableSlot);
    packed.copy(page, slot.offset);
    writeSlot(page, reusableSlot, {
      offset: slot.offset,
      length: packed.byteLength,
      hash: fnv1a32(Buffer.from(id))
    });
    return reusableSlot;
  }

  const slotCount = page.readUInt16LE(6);
  const freeStart = page.readUInt16LE(8);
  const freeEnd = page.readUInt16LE(10);
  const nextFreeStart = freeStart + SLOT_SIZE;
  const nextFreeEnd = freeEnd - packed.byteLength;

  if (nextFreeEnd < nextFreeStart) {
    throw new WotonValidationError("Record page does not have enough free space.");
  }

  packed.copy(page, nextFreeEnd);
  writeSlot(page, slotCount, {
    offset: nextFreeEnd,
    length: packed.byteLength,
    hash: fnv1a32(Buffer.from(id))
  });
  page.writeUInt16LE(slotCount + 1, 6);
  page.writeUInt16LE(nextFreeStart, 8);
  page.writeUInt16LE(nextFreeEnd, 10);
  return slotCount;
}

function findReusableSlot(page: Buffer, length: number): number | undefined {
  const slotCount = page.readUInt16LE(6);

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const slot = readSlot(page, slotIndex);

    if (slot.hash === 0 && slot.offset !== EMPTY_U16 && slot.length >= length) {
      return slotIndex;
    }
  }

  return undefined;
}

function readSlot(page: Buffer, slot: number): { readonly offset: number; readonly length: number; readonly hash: number } {
  const offset = RECORD_PAGE_HEADER_SIZE + slot * SLOT_SIZE;
  return {
    offset: page.readUInt16LE(offset),
    length: page.readUInt16LE(offset + 2),
    hash: page.readUInt32LE(offset + 4)
  };
}

function writeSlot(
  page: Buffer,
  slot: number,
  value: { readonly offset: number; readonly length: number; readonly hash: number }
): void {
  const offset = RECORD_PAGE_HEADER_SIZE + slot * SLOT_SIZE;
  page.writeUInt16LE(value.offset, offset);
  page.writeUInt16LE(value.length, offset + 2);
  page.writeUInt32LE(value.hash, offset + 4);
}

function packRecord(collection: string, record: WotonRecord<object>): Buffer {
  const collectionBytes = Buffer.from(collection, "utf8");
  const recordBytes = encodeRecord(record);
  const packed = Buffer.allocUnsafe(4 + collectionBytes.byteLength + 4 + recordBytes.byteLength);
  let offset = 0;
  packed.writeUInt32LE(collectionBytes.byteLength, offset);
  offset += 4;
  collectionBytes.copy(packed, offset);
  offset += collectionBytes.byteLength;
  packed.writeUInt32LE(recordBytes.byteLength, offset);
  offset += 4;
  recordBytes.copy(packed, offset);
  return packed;
}

function unpackRecord(bytes: Buffer): { readonly collection: string; readonly record: WotonRecord } {
  let offset = 0;

  if (bytes.byteLength < 8) {
    throw new WotonFileError("Paged record payload is truncated.");
  }

  const collectionLength = bytes.readUInt32LE(offset);
  offset += 4;
  const collectionEnd = offset + collectionLength;

  if (collectionEnd + 4 > bytes.byteLength) {
    throw new WotonFileError("Paged record collection name is truncated.");
  }

  const collection = bytes.toString("utf8", offset, collectionEnd);
  offset = collectionEnd;
  const recordLength = bytes.readUInt32LE(offset);
  offset += 4;
  const recordEnd = offset + recordLength;

  if (recordEnd !== bytes.byteLength) {
    throw new WotonFileError("Paged record payload length is invalid.");
  }

  return {
    collection,
    record: decodeRecord(bytes.subarray(offset, recordEnd))
  };
}

function assertRecordFits(record: WotonRecord<object>, collection: string, pageSize: number): void {
  if (packRecord(collection, record).byteLength + RECORD_PAGE_HEADER_SIZE + SLOT_SIZE > pageSize) {
    throw new WotonValidationError("Record is too large for one page.");
  }
}

export async function scanPagedRecordEquality(
  options: PagedEqualityScanOptions,
  query: PagedEqualityScanQuery
): Promise<PagedEqualityScanResult> {
  const pages = await openPageDevice({
    ...options,
    readOnly: true
  });
  let scannedPages = 0;
  let scannedRecords = 0;

  try {
    const pageLimit = Math.min(pages.pages, options.maxPages ?? pages.pages);

    for (let pageId = 0; pageId < pageLimit; pageId += 1) {
      const page = await pages.readPage(pageId);
      scannedPages += 1;

      if (!isRecordPage(page)) {
        continue;
      }

      const slotCount = page.readUInt16LE(6);

      for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
        const slot = readSlot(page, slotIndex);

        if (slot.length === 0 || slot.offset === EMPTY_U16 || slot.hash === 0) {
          continue;
        }

        const packed = page.subarray(slot.offset, slot.offset + slot.length);
        const decoded = unpackRecord(packed);
        scannedRecords += 1;

        if (
          decoded.collection === query.collection &&
          primitiveValuesEqual(getByPath(decoded.record, query.field), query.value)
        ) {
          return {
            pointer: {
              pageId,
              slot: slotIndex,
              checksum: crc32(packed)
            },
            scannedPages,
            scannedRecords
          };
        }
      }
    }

    return {
      scannedPages,
      scannedRecords
    };
  } finally {
    await pages.close();
  }
}

interface PageDeviceOpenOptions {
  readonly path: string;
  readonly pageSize?: PageSize;
  readonly cachePages?: number;
  readonly encryptionPassword?: string | Buffer;
  readonly minPasswordLength?: number;
  readonly readOnly?: boolean;
}

async function openPageDevice(options: PageDeviceOpenOptions): Promise<PageDevice> {
  if (options.encryptionPassword) {
    return EncryptedPageManager.open({
      path: options.path,
      password: options.encryptionPassword,
      pageSize: options.pageSize,
      cachePages: options.cachePages,
      minPasswordLength: options.minPasswordLength,
      readOnly: options.readOnly
    });
  }

  return PageManager.open({
    path: options.path,
    pageSize: options.pageSize,
    cachePages: options.cachePages,
    readOnly: options.readOnly
  });
}

function primitiveValuesEqual(left: WotonValue | undefined, right: WotonPrimitive): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

function recordKey(collection: string, id: string): string {
  return `${collection}\0${id}`;
}
