import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PagedRecordStore } from "../paged-record-store.js";
import type { WotonRecord } from "../types.js";

test("paged record store persists records outside the JS collection heap", async () => {
  const filePath = tempFile("records-basic");
  let store = await PagedRecordStore.open({ path: filePath, pageSize: 4096, cachePages: 2 });

  await store.put("users", userRecord("ana", "ana@example.com"));
  await store.put("users", userRecord("bia", "bia@example.com"));
  await store.flush();

  assert.equal(store.count("users"), 2);
  await store.close();

  store = await PagedRecordStore.open({ path: filePath, pageSize: 4096, cachePages: 2 });
  assert.equal((await store.get<UserRecord>("users", "ana"))?.email, "ana@example.com");
  assert.equal((await store.get<UserRecord>("users", "bia"))?.email, "bia@example.com");
  assert.equal(store.count("users"), 2);

  await store.close();
  await cleanup(filePath);
});

test("paged record store updates and deletes by rewriting slots", async () => {
  const filePath = tempFile("records-update-delete");
  const store = await PagedRecordStore.open({ path: filePath, pageSize: 4096 });

  await store.put("users", userRecord("ana", "old@example.com"));
  await store.put("users", userRecord("ana", "new@example.com"));
  await store.put("users", userRecord("bia", "bia@example.com"));

  assert.equal((await store.get<UserRecord>("users", "ana"))?.email, "new@example.com");
  assert.equal(store.count("users"), 2);
  assert.equal(await store.delete("users", "bia"), true);
  assert.equal(await store.delete("users", "missing"), false);
  assert.equal(store.count("users"), 1);
  assert.equal(await store.has("users", "ana"), true);
  assert.equal(await store.has("users", "bia"), false);

  await store.close();
  await cleanup(filePath);
});

test("paged record store reuses deleted slots and vacuums pages", async () => {
  const filePath = tempFile("records-vacuum");
  const store = await PagedRecordStore.open({ path: filePath, pageSize: 4096 });

  await store.put("users", userRecord("ana", "ana@example.com"));
  const deleted = await store.put("users", userRecord("old", "old@example.com"));
  await store.delete("users", "old");
  const reused = await store.put("users", userRecord("new", "new@example.com"));

  assert.equal(reused.pageId, deleted.pageId);
  assert.equal(reused.slot, deleted.slot);

  await store.vacuum();
  await store.flush();
  assert.equal((await store.get<UserRecord>("users", "new"))?.email, "new@example.com");
  assert.equal((await store.get<UserRecord>("users", "old")), null);

  await store.close();
  await cleanup(filePath);
});

test("paged record store scans records without materializing a collection map", async () => {
  const filePath = tempFile("records-scan");
  const store = await PagedRecordStore.open({ path: filePath, pageSize: 4096 });

  for (let index = 0; index < 50; index += 1) {
    await store.put("users", userRecord(`u-${index}`, `u-${index}@example.com`));
  }
  await store.put("logs", userRecord("log-1", "log@example.com"));

  const ids: string[] = [];

  for await (const record of store.records("users")) {
    ids.push(record.id);
  }

  assert.equal(ids.length, 50);
  assert.equal(ids.includes("log-1"), false);

  await store.close();
  await cleanup(filePath);
});

test("paged record store uses BC equality pointers and invalidates stale cache entries", async () => {
  const filePath = tempFile("records-bc");
  let store = await PagedRecordStore.open({ path: filePath, pageSize: 4096 });

  await store.put("users", userRecord("ana", "ana@example.com"));
  await store.put("users", userRecord("bia", "bia@example.com"));

  assert.ok(await store.warmEquality("users", "email", "ana@example.com"));
  assert.equal(store.binaryCacheSize, 1);
  assert.equal((await store.getCachedEquality<UserRecord>("users", "email", "ana@example.com"))?.id, "ana");

  await store.flush();
  await store.close();

  store = await PagedRecordStore.open({ path: filePath, pageSize: 4096 });
  assert.equal((await store.getCachedEquality<UserRecord>("users", "email", "ana@example.com"))?.id, "ana");

  await store.put("users", userRecord("ana", "new@example.com"));
  assert.equal(await store.getCachedEquality<UserRecord>("users", "email", "ana@example.com"), null);
  assert.equal((await store.findFirstByEquality<UserRecord>("users", "email", "new@example.com"))?.id, "ana");

  await store.close();
  await cleanup(filePath);
});

test("paged record store can encrypt records, id index, and BC together", async () => {
  const filePath = tempFile("records-encrypted");
  const password = "0123456789abcdef";
  let store = await PagedRecordStore.open({
    path: filePath,
    pageSize: 4096,
    encryptionPassword: password
  });

  await store.put("users", userRecord("ana", "ana-secret@example.com"));
  assert.ok(await store.warmEquality("users", "email", "ana-secret@example.com"));
  await store.close();

  const pageBytes = await readFile(filePath);
  const indexBytes = await readFile(`${filePath}-rid`);
  const cacheBytes = await readFile(`${filePath}-bc`);

  assert.equal(pageBytes.includes(Buffer.from("ana-secret@example.com")), false);
  assert.equal(indexBytes.includes(Buffer.from("ana")), false);
  assert.equal(cacheBytes.includes(Buffer.from("ana-secret@example.com")), false);

  store = await PagedRecordStore.open({
    path: filePath,
    pageSize: 4096,
    encryptionPassword: password
  });
  assert.equal((await store.findFirstByEquality<UserRecord>("users", "email", "ana-secret@example.com"))?.id, "ana");

  await store.close();
  await cleanup(filePath);
});

test("paged record store WCW warms only hot equality queries and keeps BC tiny", async () => {
  const filePath = tempFile("records-wcw");
  const store = await PagedRecordStore.open({
    path: filePath,
    pageSize: 4096,
    binaryCacheMaxEntries: 3,
    binaryCacheMaxFileBytes: 60,
    wcw: {
      minHits: 2,
      minRecords: 1,
      maxTrackedQueries: 8,
      maxPendingTasks: 8
    }
  });

  for (let index = 0; index < 16; index += 1) {
    await store.put("users", userRecord(`u-${index}`, `u-${index}@example.com`));
  }

  await store.flush();

  for (let index = 0; index < 8; index += 1) {
    store.observeEqualityQuery("users", "email", `u-${index}@example.com`);
    store.observeEqualityQuery("users", "email", `u-${index}@example.com`);
  }

  await store.waitForConnectedWorkers();

  const stats = store.connectedWorkerStats();
  assert.equal(stats?.completedTasks, 8);
  assert.equal(stats?.cachedPointers, 8);
  assert.equal(store.binaryCacheSize, 3);
  assert.equal((await stat(`${filePath}-bc`)).size <= 60, true);
  assert.equal((await store.findFirstByEquality<UserRecord>("users", "email", "u-7@example.com"))?.id, "u-7");

  await store.close();
  await cleanup(filePath);
});

interface UserRecord {
  email: string;
  active: boolean;
}

function userRecord(id: string, email: string): WotonRecord<UserRecord> {
  const now = new Date().toISOString();
  return {
    id,
    email,
    active: true,
    createdAt: now,
    updatedAt: now
  };
}

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtpg`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}-pwal`, { force: true });
  await rm(`${filePath}-pkey`, { force: true });
  await rm(`${filePath}-rid`, { force: true });
  await rm(`${filePath}-rid-pwal`, { force: true });
  await rm(`${filePath}-rid-pkey`, { force: true });
  await rm(`${filePath}-bc`, { force: true });
  await rm(`${filePath}-bc-bkey`, { force: true });
}
