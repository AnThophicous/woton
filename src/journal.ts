import type { WotonRecord } from "./types.js";

export const JOURNAL_FORMAT = "wtdb-wal-entry";
export const JOURNAL_VERSION = 1;

export type JournalFrameType = "begin" | "operation" | "commit";

export type JournalOperation =
  | { readonly type: "createCollection"; readonly collection: string }
  | { readonly type: "dropCollection"; readonly collection: string }
  | { readonly type: "putRecord"; readonly collection: string; readonly record: WotonRecord }
  | { readonly type: "deleteRecord"; readonly collection: string; readonly id: string }
  | { readonly type: "setIndexes"; readonly collection: string; readonly indexes: string[] };

export type JournalFrame =
  | JournalBeginFrame
  | JournalOperationFrame
  | JournalCommitFrame;

export interface JournalFrameBase {
  readonly version: typeof JOURNAL_VERSION;
  readonly sequence: number;
  readonly transactionId: string;
  readonly createdAt: string;
  readonly databaseUpdatedAt: string;
}

export interface JournalBeginFrame extends JournalFrameBase {
  readonly type: "begin";
}

export interface JournalOperationFrame extends JournalFrameBase {
  readonly type: "operation";
  readonly operation: JournalOperation;
}

export interface JournalCommitFrame extends JournalFrameBase {
  readonly type: "commit";
}
