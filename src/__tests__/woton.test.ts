import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Woton, WotonFileError, WotonSecurityError, type WotonRecord } from "../index.js";
import {
  decryptState,
  destroyEncryptionKey,
  encryptJournalFrameWithKey,
  openEncryptedState,
  type EncryptionKey
} from "../crypto.js";
import { crc32 } from "../fast-binary.js";
import { JOURNAL_VERSION, type JournalFrame } from "../journal.js";

interface User {
  name: string;
  email: string;
  age: number;
  active: boolean;
  roles: string[];
}

const password = "correct horse battery staple";

test("creates encrypted .wtdb files without plaintext records", async () => {
  const filePath = tempFile("encrypted");
  const db = await Woton.open({ path: filePath, password });

  await db.collection<User>("users").insert({
    id: "ana",
    name: "Ana",
    email: "ana@example.com",
    age: 27,
    active: true,
    roles: ["admin"]
  });
  await db.close();

  const bytes = await readFile(filePath);
  const text = bytes.toString("utf8");

  assert.equal(text.includes("ana@example.com"), false);
  assert.equal(text.includes("Ana"), false);
  await cleanup(filePath);
});

test("supports insert, get, update, delete and typed query builder", async () => {
  const filePath = tempFile("api");
  const db = await Woton.open({ path: filePath, password });
  const users = db.collection<User>("users");

  await users.index("email");
  await users.insert({ id: "ana", name: "Ana", email: "ana@example.com", age: 27, active: true, roles: ["admin"] });
  await users.insert({ id: "leo", name: "Leo", email: "leo@example.com", age: 17, active: true, roles: ["reader"] });
  await users.update("leo", { age: 18 });

  const adults = await users.where("age", ">=", 18).sort("name").find();
  assert.deepEqual(adults.map((user) => user.id), ["ana", "leo"]);

  const ana = await users.where("email", "ana@example.com").first();
  assert.equal(ana?.name, "Ana");

  assert.equal(await users.delete("leo"), true);
  assert.equal(await users.count(), 1);

  await db.close();
  await cleanup(filePath);
});

test("maintains indexed queries incrementally after direct writes", async () => {
  const filePath = tempFile("incremental-indexes");
  let db = await Woton.open({ path: filePath, password });
  const users = db.collection<User>("users");

  await users.index("email");
  await users.insert({ id: "ana", name: "Ana", email: "ana@example.com", age: 27, active: true, roles: [] });

  assert.deepEqual((await users.where("email", "ana@example.com").find()).map((user) => user.id), ["ana"]);

  await users.update("ana", { email: "ana.next@example.com" });

  assert.deepEqual((await users.where("email", "ana@example.com").find()).map((user) => user.id), []);
  assert.deepEqual((await users.where("email", "ana.next@example.com").find()).map((user) => user.id), ["ana"]);

  await users.put("ana", {
    name: "Ana",
    email: "ana.final@example.com",
    age: 28,
    active: false,
    roles: ["editor"]
  });

  assert.deepEqual((await users.where("email", "ana.next@example.com").find()).map((user) => user.id), []);
  assert.deepEqual((await users.where("email", "ana.final@example.com").find()).map((user) => user.id), ["ana"]);

  await users.delete("ana");
  await users.insert({ id: "bia", name: "Bia", email: "bia@example.com", age: 21, active: true, roles: [] });
  await db.close();

  const state = decryptState(await readFile(filePath), password).state;
  assert.deepEqual(state.collections.users?.persistedIndexes, {});

  db = await Woton.open({ path: filePath, password });
  const reopenedUsers = db.collection<User>("users");

  assert.deepEqual((await reopenedUsers.where("email", "bia@example.com").find()).map((user) => user.id), ["bia"]);
  assert.deepEqual((await reopenedUsers.where("email", "ana.final@example.com").find()).map((user) => user.id), []);

  await db.close();
  await cleanup(filePath);
});

test("executes the simple Woton language", async () => {
  const filePath = tempFile("language");
  const db = await Woton.open({ path: filePath, password });

  await db.query("make users");
  await db.query("index users age");
  await db.query('put users { "id": "ana", "name": "Ana", "age": 27, "active": true }');
  await db.query('put users { "id": "bia", "name": "Bia", "age": 15, "active": true }');

  const result = await db.query("from users where age >= 18 sort name asc limit 5");

  assert.equal(Array.isArray(result), true);
  assert.deepEqual((result as Array<{ id: string }>).map((record) => record.id), ["ana"]);
  assert.equal(await db.query("count users where active == true"), 2);
  assert.equal(await db.query("count users"), 2);

  await db.close();
  await cleanup(filePath);
});

test("rejects wrong passwords", async () => {
  const filePath = tempFile("wrong-password");
  const db = await Woton.open({ path: filePath, password });

  await db.collection<User>("users").insert({
    id: "ana",
    name: "Ana",
    email: "ana@example.com",
    age: 27,
    active: true,
    roles: []
  });
  await db.close();

  await assert.rejects(
    () => Woton.open({ path: filePath, password: "this password is wrong" }),
    WotonSecurityError
  );

  await cleanup(filePath);
});

test("recovers stale lock files for dead local processes", async () => {
  const filePath = tempFile("stale-lock");

  await writeFile(
    `${filePath}-lock`,
    JSON.stringify({
      pid: -1,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
      database: filePath
    })
  );

  const db = await Woton.open({ path: filePath, password });

  await db.close();
  await cleanup(filePath);
});

test("writes tokenized lock files and removes only its own lock", async () => {
  const filePath = tempFile("tokenized-lock");
  const db = await Woton.open({ path: filePath, password });
  const lock = JSON.parse(await readFile(`${filePath}-lock`, "utf8")) as {
    readonly pid: number;
    readonly hostname: string;
    readonly token: string;
    readonly database: string;
  };

  assert.equal(lock.pid, process.pid);
  assert.equal(lock.hostname, hostname());
  assert.equal(typeof lock.token, "string");
  assert.equal(lock.token.length > 16, true);
  assert.equal(lock.database, filePath);

  await db.close();
  await assert.rejects(() => readFile(`${filePath}-lock`));
  await cleanup(filePath);
});

test("does not recover a corrupt lock file without explicit forceUnlock", async () => {
  const filePath = tempFile("corrupt-lock");

  await writeFile(`${filePath}-lock`, "not-json");
  await assert.rejects(() => Woton.open({ path: filePath, password }), WotonFileError);

  const db = await Woton.open({ path: filePath, password, forceUnlock: true });
  await db.close();
  await cleanup(filePath);
});

test("commits transactions atomically and rolls back failed handlers", async () => {
  const filePath = tempFile("transaction");
  const db = await Woton.open({ path: filePath, password });

  await db.transaction(async (tx) => {
    await tx.collection<User>("users").insert({
      id: "ana",
      name: "Ana",
      email: "ana@example.com",
      age: 27,
      active: true,
      roles: ["admin"]
    });
    await tx.collection<{ event: string }>("logs").insert({ id: "log-1", event: "created" });
  });

  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await tx.collection<User>("users").insert({
        id: "bia",
        name: "Bia",
        email: "bia@example.com",
        age: 21,
        active: true,
        roles: []
      });
      throw new Error("stop");
    })
  );

  assert.equal((await db.collection<User>("users").get("ana"))?.email, "ana@example.com");
  assert.equal(await db.collection<User>("users").get("bia"), null);

  await db.close();
  await cleanup(filePath);
});

test("recovers only committed WAL transactions", async () => {
  const filePath = tempFile("wal-recovery");
  const db = await Woton.open({ path: filePath, password });
  await db.close();

  const committedTx = "committed";
  const incompleteTx = "incomplete";
  const updatedAt = new Date().toISOString();
  const frames: JournalFrame[] = [
    beginFrame(1, committedTx, updatedAt),
    operationFrame(2, committedTx, updatedAt, {
      type: "putRecord",
      collection: "users",
      record: {
        id: "ana",
        name: "Ana",
        email: "ana@example.com",
        age: 27,
        active: true,
        roles: [],
        createdAt: updatedAt,
        updatedAt
      }
    }),
    commitFrame(3, committedTx, updatedAt),
    beginFrame(4, incompleteTx, updatedAt),
    operationFrame(5, incompleteTx, updatedAt, {
      type: "putRecord",
      collection: "users",
      record: {
        id: "bia",
        name: "Bia",
        email: "bia@example.com",
        age: 21,
        active: true,
        roles: [],
        createdAt: updatedAt,
        updatedAt
      }
    })
  ];

  await writeWal(filePath, frames);

  const recovered = await Woton.open({ path: filePath, password });

  assert.equal((await recovered.collection<User>("users").get("ana"))?.email, "ana@example.com");
  assert.equal(await recovered.collection<User>("users").get("bia"), null);
  assert.equal((await recovered.stats()).journalSizeBytes, 0);

  await recovered.close();
  await cleanup(filePath);
});

test("ignores a corrupted final WAL record", async () => {
  const filePath = tempFile("wal-final-corrupt");
  const db = await Woton.open({ path: filePath, password });
  await db.close();

  const transactionId = "committed";
  const updatedAt = new Date().toISOString();
  const frames: JournalFrame[] = [
    beginFrame(1, transactionId, updatedAt),
    operationFrame(2, transactionId, updatedAt, {
      type: "putRecord",
      collection: "users",
      record: userRecord("ana", "ana@example.com", updatedAt)
    }),
    commitFrame(3, transactionId, updatedAt)
  ];

  await writeWal(filePath, frames, Buffer.from("corrupted-final-record", "utf8"));

  const recovered = await Woton.open({ path: filePath, password });
  assert.equal((await recovered.collection<User>("users").get("ana"))?.email, "ana@example.com");

  await recovered.close();
  await cleanup(filePath);
});

test("rejects a corrupted WAL record before the end", async () => {
  const filePath = tempFile("wal-middle-corrupt");
  const db = await Woton.open({ path: filePath, password });
  await db.close();

  const transactionId = "committed";
  const updatedAt = new Date().toISOString();
  const frames: JournalFrame[] = [
    beginFrame(1, transactionId, updatedAt),
    operationFrame(2, transactionId, updatedAt, {
      type: "putRecord",
      collection: "users",
      record: userRecord("ana", "ana@example.com", updatedAt)
    }),
    commitFrame(3, transactionId, updatedAt)
  ];

  await writeWalWithKey(filePath, async (encryptionKey) => {
    await writeFile(
      `${filePath}-wal`,
      Buffer.concat([
        walFrameRecord(frames[0]!, encryptionKey),
        Buffer.from("corrupted-middle-record", "utf8"),
        walFrameRecord(frames[1]!, encryptionKey),
        walFrameRecord(frames[2]!, encryptionKey)
      ])
    );
  });

  await assert.rejects(() => Woton.open({ path: filePath, password }), WotonFileError);
  await cleanup(filePath);
});

test("rejects a checksummed WAL record corrupted before a later record", async () => {
  const filePath = tempFile("wal-checksum-corrupt");
  const db = await Woton.open({ path: filePath, password });
  await db.close();

  const updatedAt = new Date().toISOString();
  const frames: JournalFrame[] = [
    beginFrame(1, "first", updatedAt),
    operationFrame(2, "first", updatedAt, {
      type: "putRecord",
      collection: "users",
      record: userRecord("ana", "ana@example.com", updatedAt)
    }),
    commitFrame(3, "first", updatedAt),
    beginFrame(4, "second", updatedAt)
  ];

  await writeWalWithKey(filePath, async (encryptionKey) => {
    const corrupted = walFrameRecord(frames[0]!, encryptionKey);
    corrupted[corrupted.byteLength - 1] = corrupted[corrupted.byteLength - 1]! ^ 0xff;
    await writeFile(
      `${filePath}-wal`,
      Buffer.concat([
        corrupted,
        walFrameRecord(frames[1]!, encryptionKey),
        walFrameRecord(frames[2]!, encryptionKey),
        walFrameRecord(frames[3]!, encryptionKey)
      ])
    );
  });

  await assert.rejects(() => Woton.open({ path: filePath, password }), WotonFileError);
  await cleanup(filePath);
});

test("recovers WAL while ignoring stale checkpoint temp files", async () => {
  const filePath = tempFile("wal-with-stale-temp");
  const db = await Woton.open({ path: filePath, password });
  await db.collection<User>("users").insert({
    id: "base",
    name: "Base",
    email: "base@example.com",
    age: 30,
    active: true,
    roles: []
  });
  await db.close();

  const updatedAt = new Date().toISOString();
  await writeWal(filePath, [
    beginFrame(1, "crash", updatedAt),
    operationFrame(2, "crash", updatedAt, {
      type: "putRecord",
      collection: "users",
      record: userRecord("ana", "ana@example.com", updatedAt)
    }),
    commitFrame(3, "crash", updatedAt)
  ]);
  await writeFile(`${filePath}.${process.pid}.stale.tmp`, Buffer.from("not the database"));

  const recovered = await Woton.open({ path: filePath, password });
  assert.equal((await recovered.collection<User>("users").get("base"))?.email, "base@example.com");
  assert.equal((await recovered.collection<User>("users").get("ana"))?.email, "ana@example.com");

  await recovered.close();
  await rm(`${filePath}.${process.pid}.stale.tmp`, { force: true });
  await cleanup(filePath);
});

test("replaying a WAL left after checkpoint does not duplicate records", async () => {
  const filePath = tempFile("wal-idempotent");
  const db = await Woton.open({ path: filePath, password });
  const updatedAt = new Date().toISOString();
  const record = userRecord("ana", "ana@example.com", updatedAt);

  await db.collection<User>("users").insert({
    id: "ana",
    name: "ana",
    email: "ana@example.com",
    age: 27,
    active: true,
    roles: []
  });
  await db.close();

  await writeWal(filePath, [
    beginFrame(1, "already-checkpointed", updatedAt),
    operationFrame(2, "already-checkpointed", updatedAt, {
      type: "putRecord",
      collection: "users",
      record
    }),
    commitFrame(3, "already-checkpointed", updatedAt)
  ]);

  const recovered = await Woton.open({ path: filePath, password });
  assert.equal(await recovered.collection<User>("users").count(), 1);
  assert.equal((await recovered.collection<User>("users").get("ana"))?.email, "ana@example.com");

  await recovered.close();
  await cleanup(filePath);
});

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtdb`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}.lock`, { force: true });
  await rm(`${filePath}-lock`, { force: true });
  await rm(`${filePath}-wal`, { force: true });
}

function beginFrame(sequence: number, transactionId: string, databaseUpdatedAt: string): JournalFrame {
  return {
    version: JOURNAL_VERSION,
    sequence,
    transactionId,
    type: "begin",
    createdAt: databaseUpdatedAt,
    databaseUpdatedAt
  };
}

function operationFrame(
  sequence: number,
  transactionId: string,
  databaseUpdatedAt: string,
  operation: Extract<JournalFrame, { type: "operation" }>["operation"]
): JournalFrame {
  return {
    version: JOURNAL_VERSION,
    sequence,
    transactionId,
    type: "operation",
    createdAt: databaseUpdatedAt,
    databaseUpdatedAt,
    operation
  };
}

function commitFrame(sequence: number, transactionId: string, databaseUpdatedAt: string): JournalFrame {
  return {
    version: JOURNAL_VERSION,
    sequence,
    transactionId,
    type: "commit",
    createdAt: databaseUpdatedAt,
    databaseUpdatedAt
  };
}

async function writeWal(filePath: string, frames: readonly JournalFrame[], trailingBytes?: Buffer): Promise<void> {
  await writeWalWithKey(filePath, async (encryptionKey) => {
    await writeFile(
      `${filePath}-wal`,
      Buffer.concat([
        ...frames.map((frame) => walFrameRecord(frame, encryptionKey)),
        ...(trailingBytes ? [trailingBytes] : [])
      ])
    );
  });
}

async function writeWalWithKey(filePath: string, write: (encryptionKey: EncryptionKey) => Promise<void>): Promise<void> {
  const opened = openEncryptedState(await readFile(filePath), password);

  try {
    await write(opened.encryptionKey);
  } finally {
    destroyEncryptionKey(opened.encryptionKey);
  }
}

function walFrameRecord(frame: JournalFrame, encryptionKey: EncryptionKey): Buffer {
  return walRecord(encryptJournalFrameWithKey(frame, encryptionKey).bytes);
}

function walRecord(payload: Buffer): Buffer {
  const magic = Buffer.from("WTW2", "ascii");
  const header = Buffer.allocUnsafe(magic.byteLength + 8);
  magic.copy(header, 0);
  header.writeUInt32LE(payload.byteLength, magic.byteLength);
  header.writeUInt32LE(crc32(payload), magic.byteLength + 4);
  return Buffer.concat([header, payload]);
}

function userRecord(id: string, email: string, updatedAt: string): WotonRecord {
  return {
    id,
    name: id,
    email,
    age: 27,
    active: true,
    roles: [],
    createdAt: updatedAt,
    updatedAt
  } as WotonRecord;
}
