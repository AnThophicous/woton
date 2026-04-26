import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { MAX_WAL_FRAME_BYTES } from "./binary-codec.js";
import { crc32, scanBytes } from "./fast-binary.js";
import {
  assertUsablePassword,
  createEncryptionKey,
  decryptJournalFrameWithKey,
  destroyEncryptionKey,
  encryptJournalFrameWithKey,
  encryptStateWithKeyProfiled,
  openEncryptedState,
  type EncryptionKey
} from "./crypto.js";
import { WotonFileError } from "./errors.js";
import { type JournalFrame } from "./journal.js";
import { CURRENT_DATABASE_STATE_VERSION, migrateDatabaseState } from "./migrations.js";
import type { DatabaseState, WotonCheckpointProfile } from "./types.js";

const DATABASE_EXTENSION = ".wtdb";
const WAL_RECORD_MAGIC_V1 = Buffer.from("WTW1", "ascii");
const WAL_RECORD_MAGIC_V2 = Buffer.from("WTW2", "ascii");
const WAL_RECORD_HEADER_LENGTH_V1 = WAL_RECORD_MAGIC_V1.byteLength + 4;
const WAL_RECORD_HEADER_LENGTH_V2 = WAL_RECORD_MAGIC_V2.byteLength + 4 + 4;

export interface StorageOpenResult {
  readonly state: DatabaseState;
  readonly recoveredJournalFrames: JournalFrame[];
  readonly migrated: boolean;
}

export class WotonStorage {
  private encryptionKey: EncryptionKey | undefined;
  private lockHandle: fs.FileHandle | undefined;
  private lockToken: string | undefined;
  private lastSaveProfile: WotonCheckpointProfile | undefined;

  constructor(
    readonly filePath: string,
    private password: string | Buffer,
    private readonly minPasswordLength: number,
    private readonly forceUnlock = false
  ) {
    assertDatabasePath(filePath);
    assertUsablePassword(password, minPasswordLength);
  }

  async open(): Promise<StorageOpenResult> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.acquireLock();

    try {
      if (await exists(this.filePath)) {
        const bytes = await fs.readFile(this.filePath);
        const result = openEncryptedState(bytes, this.password);
        const migration = migrateDatabaseState(result.state);
        this.replaceEncryptionKey(result.encryptionKey);
        return {
          state: migration.state,
          recoveredJournalFrames: await this.readJournal(),
          migrated: migration.migrated
        };
      }

      const state = createEmptyState();
      await this.save(state);
      return {
        state,
        recoveredJournalFrames: [],
        migrated: false
      };
    } catch (error) {
      await this.releaseLock().catch(() => undefined);
      throw error;
    }
  }

  async save(state: DatabaseState): Promise<void> {
    const totalStart = performance.now();
    const result = encryptStateWithKeyProfiled(state, this.getEncryptionKey());
    const writeProfile = await atomicWrite(this.filePath, result.bytes);
    this.lastSaveProfile = {
      ...result.profile,
      ...writeProfile,
      totalMs: performance.now() - totalStart
    };
  }

  async checkpoint(state: DatabaseState): Promise<void> {
    const totalStart = performance.now();
    await this.save(state);
    const directoryFsyncMs = await this.clearJournal();

    if (this.lastSaveProfile) {
      this.lastSaveProfile = {
        ...this.lastSaveProfile,
        directoryFsyncMs: this.lastSaveProfile.directoryFsyncMs + directoryFsyncMs,
        totalMs: performance.now() - totalStart
      };
    }
  }

  async appendJournal(frames: readonly JournalFrame[]): Promise<void> {
    const encryptionKey = this.getEncryptionKey();
    const handle = await fs.open(this.journalPath, "a");
    try {
      for (const frame of frames) {
        const result = encryptJournalFrameWithKey(frame, encryptionKey);
        await handle.writeFile(encodeWalRecord(result.bytes));
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async changePassword(password: string | Buffer, state: DatabaseState): Promise<void> {
    assertUsablePassword(password, this.minPasswordLength);
    this.password = password;
    this.replaceEncryptionKey(createEncryptionKey(password));
    await this.checkpoint(state);
  }

  async copyTo(targetPath: string): Promise<void> {
    assertDatabasePath(targetPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(this.filePath, targetPath);
  }

  async size(): Promise<number> {
    const stat = await fs.stat(this.filePath);
    return stat.size;
  }

  async journalSize(): Promise<number> {
    if (!(await exists(this.journalPath))) {
      return 0;
    }

    const stat = await fs.stat(this.journalPath);
    return stat.size;
  }

  checkpointProfile(): WotonCheckpointProfile | undefined {
    return this.lastSaveProfile;
  }

  async releaseLock(): Promise<void> {
    if (!this.lockHandle) {
      return;
    }

    const lockPath = this.lockPath;
    const handle = this.lockHandle;
    const token = this.lockToken;
    this.lockHandle = undefined;
    this.lockToken = undefined;

    await handle.close();

    if (token && await lockBelongsToToken(lockPath, token)) {
      await fs.unlink(lockPath).catch(() => undefined);
      await fsyncDirectory(path.dirname(lockPath));
    }

    this.replaceEncryptionKey(undefined);
  }

  private get lockPath(): string {
    return `${this.filePath}-lock`;
  }

  private get journalPath(): string {
    return `${this.filePath}-wal`;
  }

  private async readJournal(): Promise<JournalFrame[]> {
    if (!(await exists(this.journalPath))) {
      return [];
    }

    const bytes = await fs.readFile(this.journalPath);
    const frames: JournalFrame[] = [];
    let offset = 0;

    while (offset < bytes.byteLength) {
      const magicInfo = walMagicAt(bytes, offset);

      if (!magicInfo) {
        const nextMagic = findNextWalMagic(bytes, offset + 1);

        if (nextMagic === -1) {
          break;
        }

        throw new WotonFileError("The WAL contains a corrupted record before the end of the file.");
      }

      if (bytes.byteLength - offset < magicInfo.headerLength) {
        break;
      }

      const payloadLengthOffset = offset + magicInfo.magic.byteLength;
      const payloadLength = bytes.readUInt32LE(payloadLengthOffset);
      const checksumOffset = payloadLengthOffset + 4;
      const payloadOffset = magicInfo.checksummed ? checksumOffset + 4 : checksumOffset;
      const nextOffset = payloadOffset + payloadLength;

      if (payloadLength === 0 || payloadLength > MAX_WAL_FRAME_BYTES || nextOffset > bytes.byteLength) {
        const nextMagic = findNextWalMagic(bytes, offset + 1);

        if (nextMagic !== -1) {
          throw new WotonFileError("The WAL contains a corrupted record before the end of the file.");
        }

        break;
      }

      try {
        const encrypted = bytes.subarray(payloadOffset, nextOffset);

        if (magicInfo.checksummed) {
          const expectedChecksum = bytes.readUInt32LE(checksumOffset);
          const actualChecksum = crc32(encrypted);

          if (actualChecksum !== expectedChecksum) {
            const nextMagic = findNextWalMagic(bytes, offset + 1);

            if (nextMagic !== -1) {
              throw new WotonFileError("The WAL contains a corrupted record before the end of the file.");
            }

            break;
          }
        }

        frames.push(decryptJournalFrameWithKey(encrypted, this.getEncryptionKey()).value);
      } catch (error) {
        if (nextOffset === bytes.byteLength) {
          break;
        }

        throw error;
      }

      offset = nextOffset;
    }

    return frames.sort((left, right) => left.sequence - right.sequence);
  }

  private async clearJournal(): Promise<number> {
    if (!(await exists(this.journalPath))) {
      return 0;
    }

    await fs.unlink(this.journalPath);
    return fsyncDirectory(path.dirname(this.journalPath));
  }

  private async acquireLock(): Promise<void> {
    await this.recoverStaleLock();

    try {
      const token = randomUUID();
      this.lockHandle = await fs.open(this.lockPath, "wx");
      this.lockToken = token;
      await this.lockHandle.writeFile(JSON.stringify(createLockFile(this.filePath, token)));
      await this.lockHandle.sync();
      await fsyncDirectory(path.dirname(this.lockPath));
    } catch (error) {
      this.lockToken = undefined;
      await this.lockHandle?.close().catch(() => undefined);
      this.lockHandle = undefined;
      throw new WotonFileError(`The database is already open or locked: ${this.lockPath}`, { cause: error });
    }
  }

  private async recoverStaleLock(): Promise<void> {
    if (!(await exists(this.lockPath))) {
      return;
    }

    if (this.forceUnlock) {
      await fs.unlink(this.lockPath).catch(() => undefined);
      await fsyncDirectory(path.dirname(this.lockPath));
      return;
    }

    const lock = await readLockFile(this.lockPath);

    if (!lock || lock.hostname !== os.hostname()) {
      return;
    }

    if (isProcessAlive(lock.pid)) {
      return;
    }

    await fs.unlink(this.lockPath).catch(() => undefined);
    await fsyncDirectory(path.dirname(this.lockPath));
  }

  private getEncryptionKey(): EncryptionKey {
    this.encryptionKey ??= createEncryptionKey(this.password);
    return this.encryptionKey;
  }

  private replaceEncryptionKey(encryptionKey: EncryptionKey | undefined): void {
    const previous = this.encryptionKey;
    this.encryptionKey = encryptionKey;
    destroyEncryptionKey(previous);
  }
}

export function createEmptyState(): DatabaseState {
  const now = new Date().toISOString();

  return {
    meta: {
      version: CURRENT_DATABASE_STATE_VERSION,
      createdAt: now,
      updatedAt: now
    },
    collections: {}
  };
}

function assertDatabasePath(filePath: string): void {
  if (path.extname(filePath) !== DATABASE_EXTENSION) {
    throw new WotonFileError(`Woton databases must use the ${DATABASE_EXTENSION} extension.`);
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

async function atomicWrite(
  filePath: string,
  bytes: Buffer
): Promise<Pick<WotonCheckpointProfile, "writeMs" | "fsyncMs" | "renameMs" | "directoryFsyncMs">> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tempPath, "w");
  let writeMs = 0;
  let fsyncMs = 0;

  try {
    const writeStart = performance.now();
    await handle.writeFile(bytes);
    writeMs = performance.now() - writeStart;
    const fsyncStart = performance.now();
    await syncFileData(handle);
    fsyncMs = performance.now() - fsyncStart;
  } finally {
    await handle.close();
  }

  const renameStart = performance.now();
  await fs.rename(tempPath, filePath);
  const renameMs = performance.now() - renameStart;
  const directoryFsyncMs = await fsyncDirectory(path.dirname(filePath));

  return {
    writeMs,
    fsyncMs,
    renameMs,
    directoryFsyncMs
  };
}

async function syncFileData(handle: fs.FileHandle): Promise<void> {
  try {
    await handle.datasync();
  } catch {
    await handle.sync();
  }
}

function encodeWalRecord(payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(WAL_RECORD_HEADER_LENGTH_V2);
  WAL_RECORD_MAGIC_V2.copy(header, 0);
  header.writeUInt32LE(payload.byteLength, WAL_RECORD_MAGIC_V2.byteLength);
  header.writeUInt32LE(crc32(payload), WAL_RECORD_MAGIC_V2.byteLength + 4);
  return Buffer.concat([header, payload]);
}

function walMagicAt(bytes: Buffer, offset: number): {
  readonly magic: Buffer;
  readonly headerLength: number;
  readonly checksummed: boolean;
} | undefined {
  if (bytes.subarray(offset, offset + WAL_RECORD_MAGIC_V2.byteLength).equals(WAL_RECORD_MAGIC_V2)) {
    return {
      magic: WAL_RECORD_MAGIC_V2,
      headerLength: WAL_RECORD_HEADER_LENGTH_V2,
      checksummed: true
    };
  }

  if (bytes.subarray(offset, offset + WAL_RECORD_MAGIC_V1.byteLength).equals(WAL_RECORD_MAGIC_V1)) {
    return {
      magic: WAL_RECORD_MAGIC_V1,
      headerLength: WAL_RECORD_HEADER_LENGTH_V1,
      checksummed: false
    };
  }

  return undefined;
}

function findNextWalMagic(bytes: Buffer, offset: number): number {
  const nextV1 = scanBytes(bytes, WAL_RECORD_MAGIC_V1, offset);
  const nextV2 = scanBytes(bytes, WAL_RECORD_MAGIC_V2, offset);

  if (nextV1 === -1) {
    return nextV2;
  }

  if (nextV2 === -1) {
    return nextV1;
  }

  return Math.min(nextV1, nextV2);
}

async function fsyncDirectory(directoryPath: string): Promise<number> {
  const start = performance.now();
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
    return performance.now() - start;
  } catch {
    return 0;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface LockFile {
  readonly pid: number;
  readonly hostname: string;
  readonly token?: string;
  readonly processStartedAt?: string;
  readonly createdAt?: string;
  readonly database?: string;
}

function createLockFile(database: string, token: string): LockFile & {
  readonly platform: string;
  readonly node: string;
  readonly cwd: string;
} {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    token,
    processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    createdAt: new Date().toISOString(),
    database,
    platform: process.platform,
    node: process.version,
    cwd: process.cwd()
  };
}

async function readLockFile(lockPath: string): Promise<LockFile | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<LockFile>;

    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.hostname !== "string"
    ) {
      return undefined;
    }

    return {
      pid: value.pid,
      hostname: value.hostname,
      ...(typeof value.token === "string" ? { token: value.token } : {}),
      ...(typeof value.processStartedAt === "string" ? { processStartedAt: value.processStartedAt } : {}),
      ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
      ...(typeof value.database === "string" ? { database: value.database } : {})
    };
  } catch {
    return undefined;
  }
}

async function lockBelongsToToken(lockPath: string, token: string): Promise<boolean> {
  const lock = await readLockFile(lockPath);
  return lock?.token === token;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
