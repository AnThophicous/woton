export type WotonPrimitive = string | number | boolean | null;
export type WotonValue = WotonPrimitive | WotonDocument | WotonValue[];
export type WotonDocument = { [key: string]: WotonValue };

export type WotonRecord<T extends object = WotonDocument> = T & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type QueryOperator =
  | "="
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in";

export type SortDirection = "asc" | "desc";

export interface QueryCondition {
  readonly field: string;
  readonly operator: QueryOperator;
  readonly value: WotonValue;
}

export interface QueryOrder {
  readonly field: string;
  readonly direction: SortDirection;
}

export interface QuerySpec {
  readonly conditions: readonly QueryCondition[];
  readonly orderBy?: QueryOrder;
  readonly limit?: number;
  readonly offset?: number;
  readonly count?: boolean;
}

export interface StoredCollection {
  indexes: string[];
  persistedIndexes?: PersistedCollectionIndexes;
  recordCount?: number;
  records: Record<string, WotonRecord>;
}

export type PersistedCollectionIndexes = Record<string, Record<string, string[]>>;

export interface DatabaseState {
  meta: {
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  collections: Record<string, StoredCollection>;
}

export interface WotonOpenOptions {
  readonly path: string;
  readonly password: string | Buffer;
  readonly autosave?: boolean;
  readonly minPasswordLength?: number;
  readonly checkpointEveryWrites?: number;
  readonly forceUnlock?: boolean;
}

export interface WotonStats {
  readonly path: string;
  readonly formatVersion: number;
  readonly collections: number;
  readonly records: number;
  readonly indexes: number;
  readonly fileSizeBytes: number;
  readonly journalSizeBytes: number;
  readonly pendingJournalOperations: number;
  readonly encrypted: true;
  readonly lastCheckpoint?: WotonCheckpointProfile;
}

export interface WotonCheckpointProfile {
  readonly serializeMs: number;
  readonly encryptMs: number;
  readonly writeMs: number;
  readonly fsyncMs: number;
  readonly renameMs: number;
  readonly directoryFsyncMs: number;
  readonly totalMs: number;
  readonly bytes: number;
}

export interface InsertOptions {
  readonly id?: string;
}

export interface WotonCollectionInfo {
  readonly name: string;
  readonly records: number;
  readonly indexes: string[];
}
