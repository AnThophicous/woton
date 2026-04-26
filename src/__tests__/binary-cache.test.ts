import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BinaryCache, equalityQueryHash, normalizeEqualityQuery } from "../binary-cache.js";

test("binary cache persists fixed 20-byte pointer entries", async () => {
  const filePath = tempFile("bc-basic");
  let cache = await BinaryCache.open({ path: filePath });
  const queryHash = equalityQueryHash("Users", "Email", "ANA@EXAMPLE.COM");

  await cache.put({ queryHash, pageId: 12, slot: 3, checksum: 99 });
  assert.deepEqual(cache.get(queryHash), { queryHash, pageId: 12, slot: 3, checksum: 99, flags: 1 });
  await cache.close();

  cache = await BinaryCache.open({ path: filePath });
  assert.deepEqual(cache.get(queryHash), { queryHash, pageId: 12, slot: 3, checksum: 99, flags: 1 });

  await cache.close();
  await cleanup(filePath);
});

test("binary cache appends tombstones and ignores partial crash tails", async () => {
  const filePath = tempFile("bc-tombstone-tail");
  let cache = await BinaryCache.open({ path: filePath });
  const queryHash = equalityQueryHash("users", "email", "ana@example.com");

  await cache.put({ queryHash, pageId: 1, slot: 2, checksum: 3 });
  assert.equal(await cache.delete(queryHash), true);
  await cache.close();
  await writeFile(filePath, Buffer.from([1, 2, 3]), { flag: "a" });

  cache = await BinaryCache.open({ path: filePath });
  assert.equal(cache.get(queryHash), undefined);

  await cache.close();
  await cleanup(filePath);
});

test("binary cache can encrypt fixed pointer entries", async () => {
  const filePath = tempFile("bc-encrypted");
  const password = "0123456789abcdef";
  let cache = await BinaryCache.open({ path: filePath, password });
  const queryHash = equalityQueryHash("users", "email", "ana@example.com");

  await cache.put({ queryHash, pageId: 7, slot: 8, checksum: 9 });
  await cache.close();

  const bytes = await readFile(filePath);
  const plaintext = Buffer.allocUnsafe(20);
  plaintext.writeUInt32LE(queryHash, 0);
  plaintext.writeUInt32LE(7, 4);
  plaintext.writeUInt32LE(8, 8);
  plaintext.writeUInt32LE(9, 12);
  plaintext.writeUInt32LE(1, 16);
  assert.equal(bytes.includes(plaintext), false);

  cache = await BinaryCache.open({ path: filePath, password });
  assert.deepEqual(cache.get(queryHash), { queryHash, pageId: 7, slot: 8, checksum: 9, flags: 1 });

  await cache.close();
  await cleanup(filePath);
});

test("binary cache keeps a hard KB-sized storage budget", async () => {
  const filePath = tempFile("bc-budget");
  const cache = await BinaryCache.open({ path: filePath, maxEntries: 3, maxFileBytes: 60, compactAfterAppends: 4 });

  for (let index = 0; index < 20; index += 1) {
    await cache.put({
      queryHash: equalityQueryHash("users", "email", `u-${index}@example.com`),
      pageId: index,
      slot: index,
      checksum: index
    });
  }

  assert.equal(cache.size, 3);
  assert.equal((await stat(filePath)).size <= 60, true);

  await cache.close();
  await cleanup(filePath);
});

test("binary cache normalizes equality queries deterministically", () => {
  assert.equal(
    normalizeEqualityQuery(" Users ", " Email ", " ANA@EXAMPLE.COM "),
    "users:email=ana@example.com"
  );
  assert.equal(
    equalityQueryHash("Users", "Email", "ANA@EXAMPLE.COM"),
    equalityQueryHash(" users ", " email ", " ana@example.com ")
  );
});

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtbc`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}-bkey`, { force: true });
}
