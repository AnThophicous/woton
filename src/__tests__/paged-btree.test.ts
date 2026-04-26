import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PagedBTree } from "../paged-btree.js";

test("paged B+Tree persists point lookups across reopen", async () => {
  const filePath = tempFile("btree-basic");
  let tree = await PagedBTree.open({ path: filePath, pageSize: 4096, cachePages: 8 });

  for (let index = 0; index < 200; index += 1) {
    await tree.set(key(index), { pageId: index + 10, slot: index % 7, checksum: index * 3 });
  }

  assert.deepEqual(await tree.get(key(42)), { pageId: 52, slot: 0, checksum: 126 });
  await tree.close();

  tree = await PagedBTree.open({ path: filePath, pageSize: 4096, cachePages: 8 });
  assert.deepEqual(await tree.get(key(42)), { pageId: 52, slot: 0, checksum: 126 });
  assert.equal(await tree.get("missing"), undefined);

  await tree.close();
  await cleanup(filePath);
});

test("paged B+Tree updates, deletes, and scans sorted entries", async () => {
  const filePath = tempFile("btree-update-delete");
  const tree = await PagedBTree.open({ path: filePath, pageSize: 4096 });

  for (let index = 99; index >= 0; index -= 1) {
    await tree.set(key(index), { pageId: index, slot: 1, checksum: 1 });
  }

  await tree.set(key(50), { pageId: 500, slot: 2, checksum: 3 });
  assert.deepEqual(await tree.get(key(50)), { pageId: 500, slot: 2, checksum: 3 });
  assert.equal(await tree.delete(key(50)), true);
  assert.equal(await tree.delete(key(50)), false);
  assert.equal(await tree.get(key(50)), undefined);

  const entries: string[] = [];

  for await (const entry of tree.entries()) {
    entries.push(entry.key);
  }

  assert.equal(entries.length, 99);
  assert.deepEqual(entries.slice(0, 3), [key(0), key(1), key(2)]);

  await tree.close();
  await cleanup(filePath);
});

function key(index: number): string {
  return `users\0rec-${String(index).padStart(5, "0")}`;
}

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtbt`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}-pwal`, { force: true });
}
