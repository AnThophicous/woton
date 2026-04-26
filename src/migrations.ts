import { WotonSecurityError } from "./errors.js";
import type { DatabaseState, StoredCollection } from "./types.js";

export const CURRENT_DATABASE_STATE_VERSION = 2;

export interface MigrationResult {
  readonly state: DatabaseState;
  readonly migrated: boolean;
  readonly fromVersion: number;
  readonly toVersion: number;
}

export function migrateDatabaseState(value: unknown): MigrationResult {
  assertStateLike(value);

  const state = value as DatabaseState;
  const fromVersion = Number(state.meta.version || 1);
  let migrated = false;

  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > CURRENT_DATABASE_STATE_VERSION) {
    throw new WotonSecurityError(`Unsupported Woton database state version: ${String(state.meta.version)}.`);
  }

  for (const [name, collection] of Object.entries(state.collections)) {
    state.collections[name] = normalizeCollection(collection);
  }

  if (fromVersion < 2) {
    for (const collection of Object.values(state.collections)) {
      collection.persistedIndexes = {};
    }
    state.meta.version = 2;
    migrated = true;
  }

  if (state.meta.version !== CURRENT_DATABASE_STATE_VERSION) {
    state.meta.version = CURRENT_DATABASE_STATE_VERSION;
    migrated = true;
  }

  return {
    state,
    migrated,
    fromVersion,
    toVersion: CURRENT_DATABASE_STATE_VERSION
  };
}

function normalizeCollection(collection: StoredCollection): StoredCollection {
  return {
    indexes: Array.isArray(collection.indexes) ? [...new Set(collection.indexes)].sort() : [],
    persistedIndexes: isObject(collection.persistedIndexes) ? collection.persistedIndexes : {},
    records: isObject(collection.records) ? collection.records : {}
  };
}

function assertStateLike(value: unknown): asserts value is DatabaseState {
  if (!isObject(value) || !isObject(value.meta) || !isObject(value.collections)) {
    throw new WotonSecurityError("The decrypted .wtdb payload is not a valid Woton database state.");
  }

  if (typeof value.meta.createdAt !== "string" || typeof value.meta.updatedAt !== "string") {
    throw new WotonSecurityError("The decrypted .wtdb metadata is invalid.");
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
