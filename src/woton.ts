import { randomUUID } from "node:crypto";
import { WotonError, WotonValidationError } from "./errors.js";
import { JOURNAL_VERSION, type JournalFrame, type JournalOperation } from "./journal.js";
import { parseLanguage } from "./language.js";
import { getByPath, indexKey, runQuery } from "./query-engine.js";
import { WotonStorage } from "./storage.js";
import { assertCollectionName, assertDocument, assertFieldPath, assertRecordId } from "./validation.js";
import type {
  DatabaseState,
  InsertOptions,
  QueryCondition,
  QueryOperator,
  QuerySpec,
  SortDirection,
  StoredCollection,
  WotonCollectionInfo,
  WotonDocument,
  WotonOpenOptions,
  WotonRecord,
  WotonStats,
  WotonValue
} from "./types.js";

type IndexMap = Map<string, Map<string, Set<string>>>;
type WriteMutation<T> = {
  readonly result: T;
  readonly journal?: JournalOperation;
};

type TransactionUndo =
  | { readonly type: "deleteCollection"; readonly collection: string }
  | { readonly type: "restoreCollection"; readonly collection: string; readonly value: StoredCollection }
  | { readonly type: "deleteRecord"; readonly collection: string; readonly id: string }
  | { readonly type: "restoreRecord"; readonly collection: string; readonly record: WotonRecord }
  | { readonly type: "restoreIndexes"; readonly collection: string; readonly indexes: string[] };

const DEFAULT_MIN_PASSWORD_LENGTH = 16;
const DEFAULT_CHECKPOINT_EVERY_WRITES = 1_000;

export class Woton {
  private readonly storage: WotonStorage;
  private state: DatabaseState;
  private readonly autosave: boolean;
  private readonly checkpointEveryWrites: number;
  private readonly indexes = new Map<string, IndexMap>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private closed = false;
  private nextJournalSequence = 1;
  private pendingJournalOperations = 0;

  private constructor(
    options: WotonOpenOptions,
    storage: WotonStorage,
    state: DatabaseState,
    recoveredJournalFrames: readonly JournalFrame[],
    forceIndexRebuild: boolean
  ) {
    this.storage = storage;
    this.state = state;
    this.autosave = options.autosave ?? true;
    this.checkpointEveryWrites = options.checkpointEveryWrites ?? DEFAULT_CHECKPOINT_EVERY_WRITES;
    this.nextJournalSequence = recoveredJournalFrames.at(-1)?.sequence
      ? recoveredJournalFrames.at(-1)!.sequence + 1
      : 1;

    if (forceIndexRebuild) {
      this.rebuildAllIndexes();
    } else {
      this.hydrateAllIndexes();
    }
  }

  static async open(options: WotonOpenOptions): Promise<Woton> {
    const storage = new WotonStorage(
      options.path,
      options.password,
      options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH,
      options.forceUnlock ?? false
    );
    const opened = await storage.open();

    for (const transaction of committedJournalTransactions(opened.recoveredJournalFrames)) {
      for (const operation of transaction.operations) {
        applyJournalOperation(opened.state, operation);
      }
      opened.state.meta.updatedAt = transaction.databaseUpdatedAt;
    }

    const shouldCheckpoint = opened.recoveredJournalFrames.length > 0 || opened.migrated;
    const db = new Woton(options, storage, opened.state, opened.recoveredJournalFrames, shouldCheckpoint);

    if (shouldCheckpoint) {
      await db.checkpoint();
    }

    return db;
  }

  collection<T extends object = WotonDocument>(name: string): WotonCollection<T> {
    assertCollectionName(name);
    return new WotonCollection<T>(this, name);
  }

  async createCollection(name: string): Promise<WotonCollectionInfo> {
    assertCollectionName(name);

    return this.enqueueWrite(() => {
      this.ensureCollection(name);
      return {
        result: this.collectionInfo(name),
        journal: this.autosave ? {
          type: "createCollection",
          collection: name
        } : undefined
      };
    });
  }

  async dropCollection(name: string): Promise<boolean> {
    assertCollectionName(name);

    return this.enqueueWrite(() => {
      const existed = Boolean(this.state.collections[name]);
      delete this.state.collections[name];
      this.indexes.delete(name);
      return {
        result: existed,
        journal: this.autosave ? {
          type: "dropCollection",
          collection: name
        } : undefined
      };
    });
  }

  async collections(): Promise<WotonCollectionInfo[]> {
    await this.afterWrites();
    return Object.keys(this.state.collections)
      .sort()
      .map((name) => this.collectionInfo(name));
  }

  async query(input: string): Promise<unknown> {
    const command = parseLanguage(input);

    switch (command.type) {
      case "make":
        return this.createCollection(command.collection);
      case "drop":
        return this.dropCollection(command.collection);
      case "index":
        return this.collection(command.collection).index(command.field);
      case "unindex":
        return this.collection(command.collection).unindex(command.field);
      case "put":
        return this.collection(command.collection).insert(command.document);
      case "get":
        return this.collection(command.collection).get(command.id);
      case "set":
        return this.collection(command.collection).update(command.id, command.patch);
      case "del":
        return this.collection(command.collection).delete(command.id);
      case "from":
        return this.executeQuery(command.collection, command.spec) as Promise<WotonRecord[]>;
      case "count":
        return this.executeQuery(command.collection, command.spec) as Promise<number>;
    }
  }

  async transaction<T>(handler: (tx: WotonTransaction) => T | Promise<T>): Promise<T> {
    const next = this.writeQueue.then(async () => {
      this.assertOpen();

      const tx = new WotonTransaction(this.state);
      let result: T;

      try {
        result = await handler(tx);
      } catch (error) {
        tx.rollback();
        throw error;
      }

      if (tx.operations.length === 0) {
        return result;
      }

      const previousUpdatedAt = this.state.meta.updatedAt;
      this.state.meta.updatedAt = new Date().toISOString();

      if (this.autosave) {
        try {
          await this.storage.appendJournal(this.createJournalFrames(tx.operations, this.state.meta.updatedAt));
          this.pendingJournalOperations += tx.operations.length;
        } catch (error) {
          tx.rollback();
          this.state.meta.updatedAt = previousUpdatedAt;
          throw error;
        }
      }

      this.rebuildAllIndexes();
      this.dirty = true;

      if (this.autosave && this.pendingJournalOperations >= this.checkpointEveryWrites) {
        await this.checkpoint();
      }

      return result;
    });

    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  async flush(): Promise<void> {
    await this.afterWrites();

    if (this.dirty) {
      await this.checkpoint();
    }
  }

  async backup(targetPath: string): Promise<void> {
    await this.flush();
    await this.storage.copyTo(targetPath);
  }

  async changePassword(password: string | Buffer): Promise<void> {
    const next = this.writeQueue.then(async () => {
      this.assertOpen();
      if (this.dirty) {
        await this.checkpoint();
      }
      await this.storage.changePassword(password, this.state);
      this.pendingJournalOperations = 0;
      this.dirty = false;
    });

    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  async stats(): Promise<WotonStats> {
    await this.afterWrites();

    const totals = stateTotals(this.state);
    const lastCheckpoint = this.storage.checkpointProfile();

    return {
      path: this.storage.filePath,
      formatVersion: this.state.meta.version,
      collections: totals.collections,
      records: totals.records,
      indexes: totals.indexes,
      fileSizeBytes: await this.storage.size(),
      journalSizeBytes: await this.storage.journalSize(),
      pendingJournalOperations: this.pendingJournalOperations,
      encrypted: true,
      ...(lastCheckpoint ? { lastCheckpoint } : {})
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.flush();
    await this.storage.releaseLock();
    this.indexes.clear();
    this.state = {
      meta: { ...this.state.meta },
      collections: {}
    };
    this.pendingJournalOperations = 0;
    this.dirty = false;
    this.writeQueue = Promise.resolve();
    this.closed = true;
  }

  async insert<T extends object>(
    collectionName: string,
    document: T & { id?: string },
    options: InsertOptions = {}
  ): Promise<WotonRecord<T>> {
    assertCollectionName(collectionName);
    assertDocument(document);

    if (options.id) {
      assertRecordId(options.id);
    }

    return this.enqueueWrite(() => {
      const collection = this.ensureCollection(collectionName);
      const id = options.id ?? extractId(document) ?? randomUUID();

      assertRecordId(id);

      if (collection.records[id]) {
        throw new WotonValidationError(`Record "${id}" already exists in "${collectionName}".`);
      }

      const now = new Date().toISOString();
      const record = {
        ...document,
        id,
        createdAt: now,
        updatedAt: now
      } as WotonRecord<T>;

      const storedRecord = clone(record) as WotonRecord;
      collection.records[id] = storedRecord;
      collection.recordCount = collectionRecordCount(collection) + 1;
      this.addRecordToIndexes(collectionName, storedRecord);
      return {
        result: record,
        journal: this.autosave ? {
          type: "putRecord",
          collection: collectionName,
          record: clone(storedRecord) as WotonRecord
        } : undefined
      };
    });
  }

  async put<T extends object>(collectionName: string, id: string, document: T): Promise<WotonRecord<T>> {
    assertCollectionName(collectionName);
    assertRecordId(id);
    assertDocument(document);

    return this.enqueueWrite(() => {
      const collection = this.ensureCollection(collectionName);
      const current = collection.records[id];
      const now = new Date().toISOString();
      const record = {
        ...document,
        id,
        createdAt: current?.createdAt ?? now,
        updatedAt: now
      } as WotonRecord<T>;

      if (current) {
        this.removeRecordFromIndexes(collectionName, current);
      }

      const storedRecord = clone(record) as WotonRecord;
      collection.records[id] = storedRecord;
      collection.recordCount = collectionRecordCount(collection) + (current ? 0 : 1);
      this.addRecordToIndexes(collectionName, storedRecord);
      return {
        result: record,
        journal: this.autosave ? {
          type: "putRecord",
          collection: collectionName,
          record: clone(storedRecord) as WotonRecord
        } : undefined
      };
    });
  }

  async get<T extends object>(collectionName: string, id: string): Promise<WotonRecord<T> | null> {
    assertCollectionName(collectionName);
    assertRecordId(id);
    await this.afterWrites();

    const record = this.state.collections[collectionName]?.records[id] as WotonRecord<T> | undefined;
    return record ? clone(record) : null;
  }

  async update<T extends object>(
    collectionName: string,
    id: string,
    patch: Partial<T> & WotonDocument
  ): Promise<WotonRecord<T>> {
    assertCollectionName(collectionName);
    assertRecordId(id);
    assertDocument(patch);

    return this.enqueueWrite(() => {
      const collection = this.ensureCollection(collectionName);
      const current = collection.records[id] as WotonRecord<T> | undefined;

      if (!current) {
        throw new WotonValidationError(`Record "${id}" does not exist in "${collectionName}".`);
      }

      if (patch.id && patch.id !== id) {
        throw new WotonValidationError("Record id cannot be changed.");
      }

      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...safePatch } = patch;
      const record = {
        ...current,
        ...clone(safePatch),
        id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString()
      } as WotonRecord<T>;

      this.removeRecordFromIndexes(collectionName, current as WotonRecord);

      const storedRecord = clone(record) as WotonRecord;
      collection.records[id] = storedRecord;
      this.addRecordToIndexes(collectionName, storedRecord);
      return {
        result: record,
        journal: this.autosave ? {
          type: "putRecord",
          collection: collectionName,
          record: clone(storedRecord) as WotonRecord
        } : undefined
      };
    });
  }

  async delete(collectionName: string, id: string): Promise<boolean> {
    assertCollectionName(collectionName);
    assertRecordId(id);

    return this.enqueueWrite(() => {
      const collection = this.state.collections[collectionName];
      const current = collection?.records[id];
      const existed = Boolean(current);

      if (collection && current) {
        this.removeRecordFromIndexes(collectionName, current);
        delete collection.records[id];
        collection.recordCount = Math.max(0, collectionRecordCount(collection) - 1);
      }

      return {
        result: existed,
        journal: this.autosave ? {
          type: "deleteRecord",
          collection: collectionName,
          id
        } : undefined
      };
    });
  }

  async index(collectionName: string, field: string): Promise<WotonCollectionInfo> {
    assertCollectionName(collectionName);
    assertFieldPath(field);

    return this.enqueueWrite(() => {
      const collection = this.ensureCollection(collectionName);

      if (!collection.indexes.includes(field)) {
        collection.indexes = [...collection.indexes, field].sort();
      }

      this.rebuildCollectionIndexes(collectionName);
      return {
        result: this.collectionInfo(collectionName),
        journal: this.autosave ? {
          type: "setIndexes",
          collection: collectionName,
          indexes: [...collection.indexes]
        } : undefined
      };
    });
  }

  async unindex(collectionName: string, field: string): Promise<WotonCollectionInfo> {
    assertCollectionName(collectionName);
    assertFieldPath(field);

    return this.enqueueWrite(() => {
      const collection = this.ensureCollection(collectionName);
      collection.indexes = collection.indexes.filter((item) => item !== field);
      this.rebuildCollectionIndexes(collectionName);
      return {
        result: this.collectionInfo(collectionName),
        journal: this.autosave ? {
          type: "setIndexes",
          collection: collectionName,
          indexes: [...collection.indexes]
        } : undefined
      };
    });
  }

  async all<T extends object>(collectionName: string): Promise<WotonRecord<T>[]> {
    return this.executeQuery(collectionName, { conditions: [] }) as Promise<WotonRecord<T>[]>;
  }

  async executeQuery<T extends object>(collectionName: string, spec: QuerySpec): Promise<WotonRecord<T>[] | number> {
    assertCollectionName(collectionName);
    await this.afterWrites();

    const collection = this.state.collections[collectionName];

    if (!collection) {
      return spec.count ? 0 : [];
    }

    if (spec.count && spec.conditions.length === 0) {
      return collectionRecordCount(collection);
    }

    const candidates = this.candidatesFor(collectionName, collection, spec);
    return clone(runQuery(candidates, spec)) as WotonRecord<T>[] | number;
  }

  private collectionInfo(name: string): WotonCollectionInfo {
    const collection = this.state.collections[name];

    return {
      name,
      records: collection ? collectionRecordCount(collection) : 0,
      indexes: collection ? [...collection.indexes] : []
    };
  }

  private ensureCollection(name: string): StoredCollection {
    const current = this.state.collections[name];

    if (current) {
      return current;
    }

    const collection: StoredCollection = {
      indexes: [],
      persistedIndexes: {},
      recordCount: 0,
      records: {}
    };
    this.state.collections[name] = collection;
    this.indexes.set(name, new Map());
    return collection;
  }

  private candidatesFor(collectionName: string, collection: StoredCollection, spec: QuerySpec): WotonRecord[] {
    const indexedCondition = spec.conditions.find((condition) => {
      return (condition.operator === "=" || condition.operator === "==") && collection.indexes.includes(condition.field);
    });

    if (!indexedCondition) {
      return Object.values(collection.records);
    }

    const index = this.indexes.get(collectionName)?.get(indexedCondition.field);
    const ids = index?.get(indexKey(indexedCondition.value));

    if (!ids || ids.size === 0) {
      return [];
    }

    return [...ids].map((id) => collection.records[id]).filter(Boolean);
  }

  private rebuildAllIndexes(): void {
    this.indexes.clear();

    for (const name of Object.keys(this.state.collections)) {
      this.rebuildCollectionIndexes(name);
    }
  }

  private hydrateAllIndexes(): void {
    this.indexes.clear();

    for (const [name, collection] of Object.entries(this.state.collections)) {
      collection.recordCount = recordCount(collection.records);

      if (collection.indexes.length === 0) {
        collection.persistedIndexes = {};
        this.indexes.set(name, new Map());
        continue;
      }

      this.rebuildCollectionIndexes(name);
    }
  }

  private rebuildCollectionIndexes(name: string): void {
    const collection = this.state.collections[name];

    if (!collection) {
      this.indexes.delete(name);
      return;
    }

    this.indexes.set(name, new Map());
    collection.persistedIndexes = {};
    collection.recordCount = recordCount(collection.records);

    if (collection.indexes.length === 0) {
      return;
    }

    for (const record of Object.values(collection.records)) {
      this.addRecordToIndexes(name, record);
    }
  }

  private addRecordToIndexes(collectionName: string, record: WotonRecord): void {
    const collection = this.state.collections[collectionName];

    if (!collection || collection.indexes.length === 0) {
      return;
    }

    const map = this.indexes.get(collectionName) ?? new Map<string, Map<string, Set<string>>>();
    this.indexes.set(collectionName, map);

    for (const field of collection.indexes) {
      const key = indexKey(getByPath(record, field));
      const fieldIndex = map.get(field) ?? new Map<string, Set<string>>();
      const ids = fieldIndex.get(key) ?? new Set<string>();
      ids.add(record.id);
      fieldIndex.set(key, ids);
      map.set(field, fieldIndex);
    }
  }

  private removeRecordFromIndexes(collectionName: string, record: WotonRecord): void {
    const collection = this.state.collections[collectionName];

    if (!collection || collection.indexes.length === 0) {
      return;
    }

    const map = this.indexes.get(collectionName);

    for (const field of collection.indexes) {
      const key = indexKey(getByPath(record, field));
      const fieldIndex = map?.get(field);
      const ids = fieldIndex?.get(key);

      if (ids) {
        ids.delete(record.id);

        if (ids.size === 0) {
          fieldIndex?.delete(key);
        }
      }
    }
  }

  private async enqueueWrite<T>(operation: () => WriteMutation<T> | Promise<WriteMutation<T>>): Promise<T> {
    const next = this.writeQueue.then(async () => {
      this.assertOpen();
      const mutation = await operation();
      this.state.meta.updatedAt = new Date().toISOString();
      this.dirty = true;

      if (this.autosave) {
        if (!mutation.journal) {
          throw new WotonError("WOTON_INTERNAL", "Autosave mutation did not provide a WAL operation.");
        }

        await this.storage.appendJournal(this.createJournalFrames([mutation.journal], this.state.meta.updatedAt));
        this.pendingJournalOperations += 1;

        if (this.pendingJournalOperations >= this.checkpointEveryWrites) {
          await this.checkpoint();
        }
      }

      return mutation.result;
    });

    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private createJournalFrames(operations: readonly JournalOperation[], databaseUpdatedAt: string): JournalFrame[] {
    const transactionId = randomUUID();
    const createdAt = new Date().toISOString();
    const frames: JournalFrame[] = [{
      version: JOURNAL_VERSION,
      sequence: this.nextJournalSequence,
      transactionId,
      type: "begin",
      createdAt,
      databaseUpdatedAt
    }];
    this.nextJournalSequence += 1;

    for (const operation of operations) {
      frames.push({
        version: JOURNAL_VERSION,
        sequence: this.nextJournalSequence,
        transactionId,
        type: "operation",
        createdAt,
        databaseUpdatedAt,
        operation
      });
      this.nextJournalSequence += 1;
    }

    frames.push({
      version: JOURNAL_VERSION,
      sequence: this.nextJournalSequence,
      transactionId,
      type: "commit",
      createdAt,
      databaseUpdatedAt
    });
    this.nextJournalSequence += 1;

    return frames;
  }

  private async checkpoint(): Promise<void> {
    await this.storage.checkpoint(this.state);
    this.pendingJournalOperations = 0;
    this.dirty = false;
  }

  private async afterWrites(): Promise<void> {
    this.assertOpen();
    await this.writeQueue;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WotonError("WOTON_CLOSED", "This Woton database is already closed.");
    }
  }
}

export class WotonTransaction {
  readonly operations: JournalOperation[] = [];
  private readonly undo: TransactionUndo[] = [];
  private closed = false;

  constructor(private readonly state: DatabaseState) {}

  collection<T extends object = WotonDocument>(name: string): WotonTransactionCollection<T> {
    assertCollectionName(name);
    return new WotonTransactionCollection<T>(this, name);
  }

  createCollection(name: string): WotonCollectionInfo {
    assertCollectionName(name);
    this.ensureCollection(name);
    this.operations.push({ type: "createCollection", collection: name });
    return this.collectionInfo(name);
  }

  dropCollection(name: string): boolean {
    assertCollectionName(name);
    const current = this.state.collections[name];
    const existed = Boolean(current);

    if (current) {
      this.undo.push({ type: "restoreCollection", collection: name, value: clone(current) });
    }

    delete this.state.collections[name];
    this.operations.push({ type: "dropCollection", collection: name });
    return existed;
  }

  insert<T extends object>(collectionName: string, document: T & { id?: string }, options: InsertOptions = {}): WotonRecord<T> {
    assertCollectionName(collectionName);
    assertDocument(document);

    if (options.id) {
      assertRecordId(options.id);
    }

    const collection = this.ensureCollection(collectionName);
    const id = options.id ?? extractId(document) ?? randomUUID();
    assertRecordId(id);

    if (collection.records[id]) {
      throw new WotonValidationError(`Record "${id}" already exists in "${collectionName}".`);
    }

    const now = new Date().toISOString();
    const record = {
      ...clone(document),
      id,
      createdAt: now,
      updatedAt: now
    } as WotonRecord<T>;

    collection.records[id] = record as WotonRecord;
    collection.recordCount = collectionRecordCount(collection) + 1;
    this.undo.push({ type: "deleteRecord", collection: collectionName, id });
    this.operations.push({ type: "putRecord", collection: collectionName, record: clone(record) as WotonRecord });
    return clone(record);
  }

  put<T extends object>(collectionName: string, id: string, document: T): WotonRecord<T> {
    assertCollectionName(collectionName);
    assertRecordId(id);
    assertDocument(document);

    const collection = this.ensureCollection(collectionName);
    const current = collection.records[id];
    const now = new Date().toISOString();
    const record = {
      ...clone(document),
      id,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    } as WotonRecord<T>;

    if (current) {
      this.undo.push({ type: "restoreRecord", collection: collectionName, record: clone(current) });
    } else {
      this.undo.push({ type: "deleteRecord", collection: collectionName, id });
    }

    collection.records[id] = record as WotonRecord;
    collection.recordCount = collectionRecordCount(collection) + (current ? 0 : 1);
    this.operations.push({ type: "putRecord", collection: collectionName, record: clone(record) as WotonRecord });
    return clone(record);
  }

  get<T extends object>(collectionName: string, id: string): WotonRecord<T> | null {
    assertCollectionName(collectionName);
    assertRecordId(id);

    const record = this.state.collections[collectionName]?.records[id] as WotonRecord<T> | undefined;
    return record ? clone(record) : null;
  }

  update<T extends object>(collectionName: string, id: string, patch: Partial<T> & WotonDocument): WotonRecord<T> {
    assertCollectionName(collectionName);
    assertRecordId(id);
    assertDocument(patch);

    const collection = this.ensureCollection(collectionName);
    const current = collection.records[id] as WotonRecord<T> | undefined;

    if (!current) {
      throw new WotonValidationError(`Record "${id}" does not exist in "${collectionName}".`);
    }

    if (patch.id && patch.id !== id) {
      throw new WotonValidationError("Record id cannot be changed.");
    }

    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...safePatch } = patch;
    const record = {
      ...current,
      ...clone(safePatch),
      id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    } as WotonRecord<T>;

    this.undo.push({ type: "restoreRecord", collection: collectionName, record: clone(current) as WotonRecord });
    collection.records[id] = record as WotonRecord;
    this.operations.push({ type: "putRecord", collection: collectionName, record: clone(record) as WotonRecord });
    return clone(record);
  }

  delete(collectionName: string, id: string): boolean {
    assertCollectionName(collectionName);
    assertRecordId(id);

    const collection = this.state.collections[collectionName];
    const existed = Boolean(collection?.records[id]);

    if (collection && existed) {
      this.undo.push({ type: "restoreRecord", collection: collectionName, record: clone(collection.records[id]!) });
      delete collection.records[id];
      collection.recordCount = Math.max(0, collectionRecordCount(collection) - 1);
    }

    this.operations.push({ type: "deleteRecord", collection: collectionName, id });
    return existed;
  }

  index(collectionName: string, field: string): WotonCollectionInfo {
    assertCollectionName(collectionName);
    assertFieldPath(field);

    const collection = this.ensureCollection(collectionName);
    this.undo.push({ type: "restoreIndexes", collection: collectionName, indexes: [...collection.indexes] });

    if (!collection.indexes.includes(field)) {
      collection.indexes = [...collection.indexes, field].sort();
    }

    this.operations.push({ type: "setIndexes", collection: collectionName, indexes: [...collection.indexes] });
    return this.collectionInfo(collectionName);
  }

  unindex(collectionName: string, field: string): WotonCollectionInfo {
    assertCollectionName(collectionName);
    assertFieldPath(field);

    const collection = this.ensureCollection(collectionName);
    this.undo.push({ type: "restoreIndexes", collection: collectionName, indexes: [...collection.indexes] });
    collection.indexes = collection.indexes.filter((item) => item !== field);
    this.operations.push({ type: "setIndexes", collection: collectionName, indexes: [...collection.indexes] });
    return this.collectionInfo(collectionName);
  }

  all<T extends object>(collectionName: string): WotonRecord<T>[] {
    assertCollectionName(collectionName);
    return clone(Object.values(this.state.collections[collectionName]?.records ?? {}) as WotonRecord<T>[]);
  }

  executeQuery<T extends object>(collectionName: string, spec: QuerySpec): WotonRecord<T>[] | number {
    assertCollectionName(collectionName);
    const collection = this.state.collections[collectionName];

    if (!collection) {
      return spec.count ? 0 : [];
    }

    if (spec.count && spec.conditions.length === 0) {
      return collectionRecordCount(collection);
    }

    const records = Object.values(collection.records);
    return clone(runQuery(records, spec)) as WotonRecord<T>[] | number;
  }

  private collectionInfo(name: string): WotonCollectionInfo {
    const collection = this.state.collections[name];

    return {
      name,
      records: collection ? collectionRecordCount(collection) : 0,
      indexes: collection ? [...collection.indexes] : []
    };
  }

  rollback(): void {
    if (this.closed) {
      return;
    }

    for (let index = this.undo.length - 1; index >= 0; index -= 1) {
      const entry = this.undo[index]!;

      switch (entry.type) {
        case "deleteCollection":
          delete this.state.collections[entry.collection];
          break;
        case "restoreCollection":
          this.state.collections[entry.collection] = clone(entry.value);
          break;
        case "deleteRecord": {
          const collection = this.state.collections[entry.collection];

          if (collection?.records[entry.id]) {
            delete collection.records[entry.id];
            collection.recordCount = Math.max(0, collectionRecordCount(collection) - 1);
          }
          break;
        }
        case "restoreRecord": {
          const collection = ensureJournalCollection(this.state, entry.collection);
          const existed = Boolean(collection.records[entry.record.id]);
          collection.records[entry.record.id] = clone(entry.record);
          collection.recordCount = collectionRecordCount(collection) + (existed ? 0 : 1);
          break;
        }
        case "restoreIndexes":
          ensureJournalCollection(this.state, entry.collection).indexes = [...entry.indexes];
          break;
      }
    }

    this.closed = true;
  }

  private ensureCollection(name: string): StoredCollection {
    const current = this.state.collections[name];

    if (current) {
      return current;
    }

    const collection = ensureJournalCollection(this.state, name);
    this.undo.push({ type: "deleteCollection", collection: name });
    return collection;
  }
}

export class WotonTransactionCollection<T extends object = WotonDocument> {
  constructor(
    private readonly tx: WotonTransaction,
    readonly name: string
  ) {}

  async insert(document: T & { id?: string }, options?: InsertOptions): Promise<WotonRecord<T>> {
    return this.tx.insert(this.name, document, options);
  }

  async create(document: T & { id?: string }, options?: InsertOptions): Promise<WotonRecord<T>> {
    return this.insert(document, options);
  }

  async put(id: string, document: T): Promise<WotonRecord<T>> {
    return this.tx.put(this.name, id, document);
  }

  async get(id: string): Promise<WotonRecord<T> | null> {
    return this.tx.get<T>(this.name, id);
  }

  async update(id: string, patch: Partial<T> & WotonDocument): Promise<WotonRecord<T>> {
    return this.tx.update<T>(this.name, id, patch);
  }

  async delete(id: string): Promise<boolean> {
    return this.tx.delete(this.name, id);
  }

  async all(): Promise<WotonRecord<T>[]> {
    return this.tx.all<T>(this.name);
  }

  async index(field: string): Promise<WotonCollectionInfo> {
    return this.tx.index(this.name, field);
  }

  async unindex(field: string): Promise<WotonCollectionInfo> {
    return this.tx.unindex(this.name, field);
  }

  where(field: string, operator: QueryOperator, value: WotonValue): WotonTransactionQueryBuilder<T>;
  where(field: string, value: WotonValue): WotonTransactionQueryBuilder<T>;
  where(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): WotonTransactionQueryBuilder<T> {
    const builder = new WotonTransactionQueryBuilder<T>(this.tx, this.name);
    return value === undefined
      ? builder.where(field, "==", operatorOrValue as WotonValue)
      : builder.where(field, operatorOrValue as QueryOperator, value);
  }

  query(): WotonTransactionQueryBuilder<T> {
    return new WotonTransactionQueryBuilder<T>(this.tx, this.name);
  }

  async count(): Promise<number> {
    return this.tx.executeQuery(this.name, { conditions: [], count: true }) as number;
  }
}

export class WotonTransactionQueryBuilder<T extends object = WotonDocument> {
  private readonly conditions: QueryCondition[] = [];
  private order: QuerySpec["orderBy"];
  private takeValue: number | undefined;
  private skipValue: number | undefined;

  constructor(
    private readonly tx: WotonTransaction,
    private readonly collection: string
  ) {}

  where(field: string, operator: QueryOperator, value: WotonValue): this;
  where(field: string, value: WotonValue): this;
  where(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): this {
    assertFieldPath(field);

    const operator = value === undefined ? "==" : (operatorOrValue as QueryOperator);
    const actualValue = value === undefined ? (operatorOrValue as WotonValue) : value;

    this.conditions.push({ field, operator, value: actualValue });
    return this;
  }

  and(field: string, operator: QueryOperator, value: WotonValue): this;
  and(field: string, value: WotonValue): this;
  and(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): this {
    return value === undefined
      ? this.where(field, operatorOrValue as WotonValue)
      : this.where(field, operatorOrValue as QueryOperator, value);
  }

  sort(field: string, direction: SortDirection = "asc"): this {
    assertFieldPath(field);
    this.order = { field, direction };
    return this;
  }

  orderBy(field: string, direction: SortDirection = "asc"): this {
    return this.sort(field, direction);
  }

  limit(value: number): this {
    this.takeValue = value;
    return this;
  }

  take(value: number): this {
    return this.limit(value);
  }

  offset(value: number): this {
    this.skipValue = value;
    return this;
  }

  skip(value: number): this {
    return this.offset(value);
  }

  async find(): Promise<WotonRecord<T>[]> {
    return this.tx.executeQuery<T>(this.collection, this.spec(false)) as WotonRecord<T>[];
  }

  async first(): Promise<WotonRecord<T> | null> {
    const records = await this.limit(1).find();
    return records[0] ?? null;
  }

  async count(): Promise<number> {
    return this.tx.executeQuery(this.collection, this.spec(true)) as number;
  }

  private spec(count: boolean): QuerySpec {
    return {
      conditions: [...this.conditions],
      orderBy: this.order,
      limit: this.takeValue,
      offset: this.skipValue,
      count
    };
  }
}

export class WotonCollection<T extends object = WotonDocument> {
  constructor(
    private readonly db: Woton,
    readonly name: string
  ) {}

  insert(document: T & { id?: string }, options?: InsertOptions): Promise<WotonRecord<T>> {
    return this.db.insert(this.name, document, options);
  }

  create(document: T & { id?: string }, options?: InsertOptions): Promise<WotonRecord<T>> {
    return this.insert(document, options);
  }

  put(id: string, document: T): Promise<WotonRecord<T>> {
    return this.db.put(this.name, id, document);
  }

  get(id: string): Promise<WotonRecord<T> | null> {
    return this.db.get<T>(this.name, id);
  }

  update(id: string, patch: Partial<T> & WotonDocument): Promise<WotonRecord<T>> {
    return this.db.update<T>(this.name, id, patch);
  }

  delete(id: string): Promise<boolean> {
    return this.db.delete(this.name, id);
  }

  all(): Promise<WotonRecord<T>[]> {
    return this.db.all<T>(this.name);
  }

  index(field: string): Promise<WotonCollectionInfo> {
    return this.db.index(this.name, field);
  }

  unindex(field: string): Promise<WotonCollectionInfo> {
    return this.db.unindex(this.name, field);
  }

  where(field: string, operator: QueryOperator, value: WotonValue): WotonQueryBuilder<T>;
  where(field: string, value: WotonValue): WotonQueryBuilder<T>;
  where(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): WotonQueryBuilder<T> {
    const builder = new WotonQueryBuilder<T>(this.db, this.name);
    return value === undefined
      ? builder.where(field, "==", operatorOrValue as WotonValue)
      : builder.where(field, operatorOrValue as QueryOperator, value);
  }

  query(): WotonQueryBuilder<T> {
    return new WotonQueryBuilder<T>(this.db, this.name);
  }

  count(): Promise<number> {
    return this.db.executeQuery(this.name, { conditions: [], count: true }) as Promise<number>;
  }
}

export class WotonQueryBuilder<T extends object = WotonDocument> {
  private readonly conditions: QueryCondition[] = [];
  private order: QuerySpec["orderBy"];
  private takeValue: number | undefined;
  private skipValue: number | undefined;

  constructor(
    private readonly db: Woton,
    private readonly collection: string
  ) {}

  where(field: string, operator: QueryOperator, value: WotonValue): this;
  where(field: string, value: WotonValue): this;
  where(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): this {
    assertFieldPath(field);

    const operator = value === undefined ? "==" : (operatorOrValue as QueryOperator);
    const actualValue = value === undefined ? (operatorOrValue as WotonValue) : value;

    this.conditions.push({
      field,
      operator,
      value: actualValue
    });
    return this;
  }

  and(field: string, operator: QueryOperator, value: WotonValue): this;
  and(field: string, value: WotonValue): this;
  and(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): this {
    return value === undefined
      ? this.where(field, operatorOrValue as WotonValue)
      : this.where(field, operatorOrValue as QueryOperator, value);
  }

  sort(field: string, direction: SortDirection = "asc"): this {
    assertFieldPath(field);
    this.order = { field, direction };
    return this;
  }

  orderBy(field: string, direction: SortDirection = "asc"): this {
    return this.sort(field, direction);
  }

  limit(value: number): this {
    this.takeValue = value;
    return this;
  }

  take(value: number): this {
    return this.limit(value);
  }

  offset(value: number): this {
    this.skipValue = value;
    return this;
  }

  skip(value: number): this {
    return this.offset(value);
  }

  async find(): Promise<WotonRecord<T>[]> {
    return this.db.executeQuery<T>(this.collection, this.spec(false)) as Promise<WotonRecord<T>[]>;
  }

  async first(): Promise<WotonRecord<T> | null> {
    const records = await this.limit(1).find();
    return records[0] ?? null;
  }

  async count(): Promise<number> {
    return this.db.executeQuery(this.collection, this.spec(true)) as Promise<number>;
  }

  private spec(count: boolean): QuerySpec {
    return {
      conditions: [...this.conditions],
      orderBy: this.order,
      limit: this.takeValue,
      offset: this.skipValue,
      count
    };
  }
}

interface RecoveredJournalTransaction {
  readonly databaseUpdatedAt: string;
  readonly operations: JournalOperation[];
}

function committedJournalTransactions(frames: readonly JournalFrame[]): RecoveredJournalTransaction[] {
  const open = new Map<string, RecoveredJournalTransaction>();
  const committed: RecoveredJournalTransaction[] = [];

  for (const frame of frames) {
    if (frame.type === "begin") {
      open.set(frame.transactionId, {
        databaseUpdatedAt: frame.databaseUpdatedAt,
        operations: []
      });
      continue;
    }

    const transaction = open.get(frame.transactionId);
    if (!transaction) {
      continue;
    }

    if (frame.type === "operation") {
      transaction.operations.push(frame.operation);
      continue;
    }

    committed.push({
      databaseUpdatedAt: frame.databaseUpdatedAt,
      operations: [...transaction.operations]
    });
    open.delete(frame.transactionId);
  }

  return committed;
}

function applyJournalOperation(state: DatabaseState, operation: JournalOperation): void {
  switch (operation.type) {
    case "createCollection":
      ensureJournalCollection(state, operation.collection);
      break;
    case "dropCollection":
      delete state.collections[operation.collection];
      break;
    case "putRecord":
      {
        const collection = ensureJournalCollection(state, operation.collection);
        const existed = Boolean(collection.records[operation.record.id]);
        collection.records[operation.record.id] = clone(operation.record);
        collection.recordCount = collectionRecordCount(collection) + (existed ? 0 : 1);
      }
      break;
    case "deleteRecord": {
      const collection = state.collections[operation.collection];
      if (collection?.records[operation.id]) {
        delete collection.records[operation.id];
        collection.recordCount = Math.max(0, collectionRecordCount(collection) - 1);
      }
      break;
    }
    case "setIndexes":
      ensureJournalCollection(state, operation.collection).indexes = [...operation.indexes].sort();
      break;
  }
}

function ensureJournalCollection(state: DatabaseState, name: string): StoredCollection {
  const current = state.collections[name];

  if (current) {
    return current;
  }

  const collection: StoredCollection = {
    indexes: [],
    persistedIndexes: {},
    recordCount: 0,
    records: {}
  };
  state.collections[name] = collection;
  return collection;
}

function stateTotals(state: DatabaseState): { readonly collections: number; readonly records: number; readonly indexes: number } {
  let collections = 0;
  let records = 0;
  let indexes = 0;

  for (const name in state.collections) {
    const collection = state.collections[name]!;
    collections += 1;
    records += collectionRecordCount(collection);
    indexes += collection.indexes.length;
  }

  return {
    collections,
    records,
    indexes
  };
}

function recordCount(records: Record<string, WotonRecord>): number {
  let count = 0;

  for (const _id in records) {
    count += 1;
  }

  return count;
}

function collectionRecordCount(collection: StoredCollection): number {
  collection.recordCount ??= recordCount(collection.records);
  return collection.recordCount;
}

function extractId(document: object & { id?: unknown }): string | undefined {
  return typeof document.id === "string" ? document.id : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
