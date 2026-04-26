import { JOURNAL_VERSION, type JournalFrame, type JournalOperation } from "./journal.js";
import type { DatabaseState, PersistedCollectionIndexes, StoredCollection, WotonRecord, WotonValue } from "./types.js";

const VALUE_NULL = 0;
const VALUE_FALSE = 1;
const VALUE_TRUE = 2;
const VALUE_NUMBER = 3;
const VALUE_STRING = 4;
const VALUE_ARRAY = 5;
const VALUE_OBJECT = 6;

const FRAME_BEGIN = 1;
const FRAME_OPERATION = 2;
const FRAME_COMMIT = 3;

const OP_CREATE_COLLECTION = 1;
const OP_DROP_COLLECTION = 2;
const OP_PUT_RECORD = 3;
const OP_DELETE_RECORD = 4;
const OP_SET_INDEXES = 5;

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_WAL_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_STRING_BYTES = 8 * 1024 * 1024;
const MAX_COLLECTIONS = 100_000;
const MAX_RECORDS_PER_COLLECTION = 10_000_000;
const MAX_INDEX_FIELDS = 10_000;
const MAX_INDEX_KEYS = 5_000_000;
const MAX_ARRAY_LENGTH = 1_000_000;
const MAX_OBJECT_KEYS = 100_000;
const MAX_NESTING_DEPTH = 64;
const SCHEMA_RECORDS_FORMAT_VERSION = 3;

interface DatabaseEncodingPlan {
  readonly size: number;
  readonly collections: CollectionEncodingPlan[];
}

interface CollectionEncodingPlan {
  readonly name: string;
  readonly collection: StoredCollection;
  readonly recordCount: number;
  readonly schema: string[];
}

export function encodeDatabaseState(state: DatabaseState): Buffer {
  const plan = planDatabaseState(state);
  const writer = new BinaryWriter(plan.size);
  writer.u32(state.meta.version);
  writer.string(state.meta.createdAt);
  writer.string(state.meta.updatedAt);

  writer.u32(plan.collections.length);

  for (const { name, collection, recordCount, schema } of plan.collections) {
    writer.string(name);
    writeStringArray(writer, collection.indexes);
    writePersistedIndexes(writer, collection.persistedIndexes ?? {});
    writeStringArray(writer, schema);
    writer.u32(recordCount);

    for (const id in collection.records) {
      writeRecordBySchema(writer, collection.records[id]!, schema);
    }
  }

  return writer.buffer();
}

export function decodeDatabaseState(bytes: Buffer, formatVersion = SCHEMA_RECORDS_FORMAT_VERSION): DatabaseState {
  return formatVersion >= SCHEMA_RECORDS_FORMAT_VERSION
    ? decodeDatabaseStateWithSchemas(bytes)
    : decodeDatabaseStateLegacy(bytes);
}

export function encodeRecord(record: WotonRecord<object>): Buffer {
  const genericRecord = record as WotonRecord;
  const writer = new BinaryWriter(valueSize(genericRecord));
  writeValue(writer, genericRecord);
  return writer.buffer();
}

export function decodeRecord(bytes: Buffer): WotonRecord {
  const reader = new BinaryReader(bytes);
  const record = readValue(reader) as WotonRecord;
  reader.done();

  if (typeof record.id !== "string") {
    throw new Error("Binary record is missing a string id.");
  }

  return record;
}

function decodeDatabaseStateWithSchemas(bytes: Buffer): DatabaseState {
  ensureLimit(bytes.byteLength, MAX_SNAPSHOT_BYTES, "snapshot bytes");
  const reader = new BinaryReader(bytes);
  const state: DatabaseState = {
    meta: {
      version: reader.u32(),
      createdAt: reader.string(),
      updatedAt: reader.string()
    },
    collections: {}
  };

  const collectionCount = reader.count(MAX_COLLECTIONS, "collection count");

  for (let index = 0; index < collectionCount; index += 1) {
    const name = reader.string();
    const collection: StoredCollection = {
      indexes: readStringArray(reader),
      persistedIndexes: readPersistedIndexes(reader),
      recordCount: 0,
      records: {}
    };
    const schema = readStringArray(reader, MAX_OBJECT_KEYS, "record schema length");
    const recordCount = reader.count(MAX_RECORDS_PER_COLLECTION, "record count");

    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      const record = readRecordBySchema(reader, schema);

      if (collection.records[record.id]) {
        throw new Error("Binary collection contains duplicate record ids.");
      }

      collection.records[record.id] = record;
      collection.recordCount = (collection.recordCount ?? 0) + 1;
    }

    state.collections[name] = collection;
  }

  reader.done();
  return state;
}

function decodeDatabaseStateLegacy(bytes: Buffer): DatabaseState {
  ensureLimit(bytes.byteLength, MAX_SNAPSHOT_BYTES, "snapshot bytes");
  const reader = new BinaryReader(bytes);
  const state: DatabaseState = {
    meta: {
      version: reader.u32(),
      createdAt: reader.string(),
      updatedAt: reader.string()
    },
    collections: {}
  };

  const collectionCount = reader.count(MAX_COLLECTIONS, "collection count");

  for (let index = 0; index < collectionCount; index += 1) {
    const name = reader.string();
    const collection: StoredCollection = {
      indexes: readStringArray(reader),
      persistedIndexes: readPersistedIndexes(reader),
      recordCount: 0,
      records: {}
    };
    const recordCount = reader.count(MAX_RECORDS_PER_COLLECTION, "record count");

    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      const id = reader.string();
      collection.records[id] = readValue(reader) as WotonRecord;
      collection.recordCount = (collection.recordCount ?? 0) + 1;
    }

    state.collections[name] = collection;
  }

  reader.done();
  return state;
}

export function encodeJournalFrame(frame: JournalFrame): Buffer {
  const writer = new BinaryWriter(journalFrameSize(frame));
  writer.u32(frame.version);
  writer.u64(frame.sequence);
  writer.string(frame.transactionId);
  writer.string(frame.createdAt);
  writer.string(frame.databaseUpdatedAt);

  switch (frame.type) {
    case "begin":
      writer.u8(FRAME_BEGIN);
      break;
    case "operation":
      writer.u8(FRAME_OPERATION);
      writeJournalOperation(writer, frame.operation);
      break;
    case "commit":
      writer.u8(FRAME_COMMIT);
      break;
  }

  return writer.buffer();
}

export function decodeJournalFrame(bytes: Buffer): JournalFrame {
  ensureLimit(bytes.byteLength, MAX_WAL_FRAME_BYTES, "WAL frame bytes");
  const reader = new BinaryReader(bytes);
  const version = reader.u32();

  if (version !== JOURNAL_VERSION) {
    throw new Error(`Unsupported WAL frame version: ${version}`);
  }

  const base = {
    version: JOURNAL_VERSION,
    sequence: reader.u64(),
    transactionId: reader.string(),
    createdAt: reader.string(),
    databaseUpdatedAt: reader.string()
  } as const;
  const type = reader.u8();
  let frame: JournalFrame;

  switch (type) {
    case FRAME_BEGIN:
      frame = { ...base, type: "begin" };
      break;
    case FRAME_OPERATION:
      frame = { ...base, type: "operation", operation: readJournalOperation(reader) };
      break;
    case FRAME_COMMIT:
      frame = { ...base, type: "commit" };
      break;
    default:
      throw new Error(`Unsupported WAL frame type: ${type}`);
  }

  reader.done();
  return frame;
}

function writeJournalOperation(writer: BinaryWriter, operation: JournalOperation): void {
  switch (operation.type) {
    case "createCollection":
      writer.u8(OP_CREATE_COLLECTION);
      writer.string(operation.collection);
      break;
    case "dropCollection":
      writer.u8(OP_DROP_COLLECTION);
      writer.string(operation.collection);
      break;
    case "putRecord":
      writer.u8(OP_PUT_RECORD);
      writer.string(operation.collection);
      writeValue(writer, operation.record);
      break;
    case "deleteRecord":
      writer.u8(OP_DELETE_RECORD);
      writer.string(operation.collection);
      writer.string(operation.id);
      break;
    case "setIndexes":
      writer.u8(OP_SET_INDEXES);
      writer.string(operation.collection);
      writeStringArray(writer, operation.indexes);
      break;
  }
}

function readJournalOperation(reader: BinaryReader): JournalOperation {
  const type = reader.u8();

  switch (type) {
    case OP_CREATE_COLLECTION:
      return { type: "createCollection", collection: reader.string() };
    case OP_DROP_COLLECTION:
      return { type: "dropCollection", collection: reader.string() };
    case OP_PUT_RECORD:
      return { type: "putRecord", collection: reader.string(), record: readValue(reader) as WotonRecord };
    case OP_DELETE_RECORD:
      return { type: "deleteRecord", collection: reader.string(), id: reader.string() };
    case OP_SET_INDEXES:
      return { type: "setIndexes", collection: reader.string(), indexes: readStringArray(reader) };
    default:
      throw new Error(`Unsupported WAL operation type: ${type}`);
  }
}

function writePersistedIndexes(writer: BinaryWriter, indexes: PersistedCollectionIndexes): void {
  writer.u32(recordEntryCount(indexes));

  for (const field in indexes) {
    const fieldIndex = indexes[field]!;
    writer.string(field);
    writer.u32(recordEntryCount(fieldIndex));

    for (const key in fieldIndex) {
      writer.string(key);
      writeStringArray(writer, fieldIndex[key]!);
    }
  }
}

function readPersistedIndexes(reader: BinaryReader): PersistedCollectionIndexes {
  const indexes: PersistedCollectionIndexes = {};
  const fieldCount = reader.count(MAX_INDEX_FIELDS, "persisted index field count");

  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
    const field = reader.string();
    indexes[field] = {};
    const keyCount = reader.count(MAX_INDEX_KEYS, "persisted index key count");

    for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
      indexes[field][reader.string()] = readStringArray(reader);
    }
  }

  return indexes;
}

function writeStringArray(writer: BinaryWriter, values: readonly string[]): void {
  writer.u32(values.length);

  for (const value of values) {
    writer.string(value);
  }
}

function readStringArray(reader: BinaryReader, limit = MAX_ARRAY_LENGTH, label = "string array length"): string[] {
  const length = reader.count(limit, label);
  const values: string[] = [];

  for (let index = 0; index < length; index += 1) {
    values.push(reader.string());
  }

  return values;
}

function writeRecordBySchema(writer: BinaryWriter, record: WotonRecord, schema: readonly string[]): void {
  for (const key of schema) {
    if (hasOwn(record, key)) {
      writer.u8(1);
      writeValue(writer, record[key] as WotonValue);
      continue;
    }

    writer.u8(0);
  }
}

function readRecordBySchema(reader: BinaryReader, schema: readonly string[]): WotonRecord {
  const value: Record<string, WotonValue> = {};

  for (const key of schema) {
    const present = reader.u8();

    if (present === 0) {
      continue;
    }

    if (present !== 1) {
      throw new Error("Binary record schema presence marker is invalid.");
    }

    value[key] = readValue(reader) as WotonValue;
  }

  if (typeof value.id !== "string") {
    throw new Error("Binary record is missing a string id.");
  }

  return value as WotonRecord;
}

function writeValue(writer: BinaryWriter, value: WotonValue | WotonRecord): void {
  if (value === null) {
    writer.u8(VALUE_NULL);
    return;
  }

  switch (typeof value) {
    case "boolean":
      writer.u8(value ? VALUE_TRUE : VALUE_FALSE);
      return;
    case "number":
      writer.u8(VALUE_NUMBER);
      writer.f64(value);
      return;
    case "string":
      writer.u8(VALUE_STRING);
      writer.string(value);
      return;
    case "object":
      if (Array.isArray(value)) {
        writer.u8(VALUE_ARRAY);
        writer.u32(value.length);

        for (const item of value) {
          writeValue(writer, item);
        }

        return;
      }

      writer.u8(VALUE_OBJECT);
      {
        writer.u32(recordEntryCount(value));

        for (const key in value) {
          writer.string(key);
          writeValue(writer, value[key] as WotonValue);
        }
      }
      return;
  }
}

function readValue(reader: BinaryReader, depth = 0): WotonValue | WotonRecord {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error("Binary payload nesting is too deep.");
  }

  const type = reader.u8();

  switch (type) {
    case VALUE_NULL:
      return null;
    case VALUE_FALSE:
      return false;
    case VALUE_TRUE:
      return true;
    case VALUE_NUMBER:
      return reader.f64();
    case VALUE_STRING:
      return reader.string();
    case VALUE_ARRAY: {
      const length = reader.count(MAX_ARRAY_LENGTH, "array length");
      const values: WotonValue[] = [];

      for (let index = 0; index < length; index += 1) {
        values.push(readValue(reader, depth + 1) as WotonValue);
      }

      return values;
    }
    case VALUE_OBJECT: {
      const length = reader.count(MAX_OBJECT_KEYS, "object key count");
      const value: Record<string, WotonValue> = {};

      for (let index = 0; index < length; index += 1) {
        value[reader.string()] = readValue(reader, depth + 1) as WotonValue;
      }

      return value as WotonRecord;
    }
    default:
      throw new Error(`Unsupported value type: ${type}`);
  }
}

function planDatabaseState(state: DatabaseState): DatabaseEncodingPlan {
  let size = 4 + stringSize(state.meta.createdAt) + stringSize(state.meta.updatedAt) + 4;
  const collections: CollectionEncodingPlan[] = [];

  for (const name in state.collections) {
    const collection = state.collections[name]!;
    const recordCount = recordEntryCount(collection.records);
    const schema = recordSchema(collection.records);
    collections.push({
      name,
      collection,
      recordCount,
      schema
    });

    size += stringSize(name);
    size += stringArraySize(collection.indexes);
    size += persistedIndexesSize(collection.persistedIndexes ?? {});
    size += stringArraySize(schema);
    size += 4;

    for (const id in collection.records) {
      size += schemaRecordSize(collection.records[id]!, schema);
    }
  }

  return {
    size,
    collections
  };
}

function recordSchema(records: Record<string, WotonRecord>): string[] {
  const seen = new Set<string>();
  const schema: string[] = [];

  for (const id in records) {
    for (const key in records[id]!) {
      if (!seen.has(key)) {
        seen.add(key);
        schema.push(key);
      }
    }
  }

  return schema;
}

function schemaRecordSize(record: WotonRecord, schema: readonly string[]): number {
  let size = 0;

  for (const key of schema) {
    size += 1;

    if (hasOwn(record, key)) {
      size += valueSize(record[key] as WotonValue);
    }
  }

  return size;
}

function journalFrameSize(frame: JournalFrame): number {
  let size = 4 + 8 + stringSize(frame.transactionId) + stringSize(frame.createdAt) + stringSize(frame.databaseUpdatedAt) + 1;

  if (frame.type === "operation") {
    size += journalOperationSize(frame.operation);
  }

  return size;
}

function journalOperationSize(operation: JournalOperation): number {
  switch (operation.type) {
    case "createCollection":
    case "dropCollection":
      return 1 + stringSize(operation.collection);
    case "putRecord":
      return 1 + stringSize(operation.collection) + valueSize(operation.record);
    case "deleteRecord":
      return 1 + stringSize(operation.collection) + stringSize(operation.id);
    case "setIndexes":
      return 1 + stringSize(operation.collection) + stringArraySize(operation.indexes);
  }
}

function persistedIndexesSize(indexes: PersistedCollectionIndexes): number {
  let size = 4;

  for (const field in indexes) {
    const fieldIndex = indexes[field]!;
    size += stringSize(field) + 4;

    for (const key in fieldIndex) {
      size += stringSize(key);
      size += stringArraySize(fieldIndex[key]!);
    }
  }

  return size;
}

function stringArraySize(values: readonly string[]): number {
  let size = 4;

  for (const value of values) {
    size += stringSize(value);
  }

  return size;
}

function valueSize(value: WotonValue | WotonRecord): number {
  if (value === null) {
    return 1;
  }

  switch (typeof value) {
    case "boolean":
      return 1;
    case "number":
      return 1 + 8;
    case "string":
      return 1 + stringSize(value);
    case "object":
      if (Array.isArray(value)) {
        let size = 1 + 4;

        for (const item of value) {
          size += valueSize(item);
        }

        return size;
      }

      {
        let size = 1 + 4;

        for (const key in value) {
          size += stringSize(key);
          size += valueSize(value[key] as WotonValue);
        }

        return size;
      }
  }
}

function stringSize(value: string): number {
  return 4 + Buffer.byteLength(value, "utf8");
}

function recordEntryCount(value: object): number {
  let count = 0;

  for (const _key in value) {
    count += 1;
  }

  return count;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ensureLimit(value: number, limit: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > limit) {
    throw new Error(`Binary ${label} exceeds the supported limit.`);
  }
}

class BinaryWriter {
  private readonly bytes: Buffer;
  private offset = 0;

  constructor(size: number) {
    this.bytes = Buffer.allocUnsafe(size);
  }

  u8(value: number): void {
    this.bytes.writeUInt8(value, this.offset);
    this.offset += 1;
  }

  u32(value: number): void {
    this.bytes.writeUInt32LE(value, this.offset);
    this.offset += 4;
  }

  u64(value: number): void {
    this.bytes.writeBigUInt64LE(BigInt(value), this.offset);
    this.offset += 8;
  }

  f64(value: number): void {
    this.bytes.writeDoubleLE(value, this.offset);
    this.offset += 8;
  }

  string(value: string): void {
    const length = Buffer.byteLength(value, "utf8");
    this.u32(length);
    this.offset += this.bytes.write(value, this.offset, length, "utf8");
  }

  buffer(): Buffer {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error("Binary writer size calculation is incorrect.");
    }

    return this.bytes;
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  u8(): number {
    this.require(1);
    const value = this.bytes.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  count(limit: number, label: string): number {
    const value = this.u32();
    ensureLimit(value, limit, label);
    return value;
  }

  u64(): number {
    this.require(8);
    const value = Number(this.bytes.readBigUInt64LE(this.offset));
    this.offset += 8;

    if (!Number.isSafeInteger(value)) {
      throw new Error("Binary integer is outside the safe JavaScript range.");
    }

    return value;
  }

  f64(): number {
    this.require(8);
    const value = this.bytes.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  string(): string {
    const length = this.u32();
    ensureLimit(length, MAX_STRING_BYTES, "string bytes");
    this.require(length);
    const value = this.bytes.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  done(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error("Binary payload has trailing bytes.");
    }
  }

  private require(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error("Binary payload is truncated.");
    }
  }
}
