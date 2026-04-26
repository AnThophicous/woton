import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WotonFileError } from "../errors.js";
import { encodePageWalRecord, PageManager } from "../page-manager.js";

test("page manager persists fixed-size pages and uses a bounded clean cache", async () => {
  const filePath = tempFile("page-basic");
  const manager = await PageManager.open({ path: filePath, pageSize: 4096, cachePages: 1 });

  const first = manager.allocatePage();
  const second = manager.allocatePage();
  manager.writePage(first, Buffer.from("first"));
  manager.writePage(second, Buffer.from("second"));
  await manager.flush();

  assert.equal(manager.cachedPages <= 1, true);
  await manager.close();

  const reopened = await PageManager.open({ path: filePath, pageSize: 4096, cachePages: 1 });
  assert.equal((await reopened.readPage(first)).subarray(0, 5).toString(), "first");
  assert.equal((await reopened.readPage(second)).subarray(0, 6).toString(), "second");

  await reopened.close();
  await cleanup(filePath);
});

test("page manager recovers committed page WAL after a simulated crash", async () => {
  const filePath = tempFile("page-recovery");
  let manager = await PageManager.open({ path: filePath, pageSize: 4096 });
  const pageId = manager.allocatePage();
  await manager.flush();
  await manager.close();

  const page = Buffer.alloc(4096);
  page.write("after-crash");
  await writeFile(`${filePath}-pwal`, encodePageWalRecord(pageId, page));

  manager = await PageManager.open({ path: filePath, pageSize: 4096 });
  assert.equal((await manager.readPage(pageId)).subarray(0, 11).toString(), "after-crash");

  await manager.close();
  await cleanup(filePath);
});

test("page manager ignores a corrupted final page WAL record", async () => {
  const filePath = tempFile("page-final-corrupt");
  let manager = await PageManager.open({ path: filePath, pageSize: 4096 });
  const pageId = manager.allocatePage();
  await manager.flush();
  await manager.close();

  const page = Buffer.alloc(4096);
  page.write("valid");
  await writeFile(`${filePath}-pwal`, Buffer.concat([encodePageWalRecord(pageId, page), Buffer.from("corrupt")]));

  manager = await PageManager.open({ path: filePath, pageSize: 4096 });
  assert.equal((await manager.readPage(pageId)).subarray(0, 5).toString(), "valid");

  await manager.close();
  await cleanup(filePath);
});

test("page manager rejects page WAL corruption before a later record", async () => {
  const filePath = tempFile("page-middle-corrupt");
  let manager = await PageManager.open({ path: filePath, pageSize: 4096 });
  const first = manager.allocatePage();
  const second = manager.allocatePage();
  await manager.flush();
  await manager.close();

  const firstPage = Buffer.alloc(4096);
  const secondPage = Buffer.alloc(4096);
  firstPage.write("first");
  secondPage.write("second");

  await writeFile(
    `${filePath}-pwal`,
    Buffer.concat([
      encodePageWalRecord(first, firstPage),
      Buffer.from("corrupted-middle"),
      encodePageWalRecord(second, secondPage)
    ])
  );

  await assert.rejects(() => PageManager.open({ path: filePath, pageSize: 4096 }), WotonFileError);
  await cleanup(filePath);
});

test("page manager rejects corrupted page data", async () => {
  const filePath = tempFile("page-data-corrupt");
  const manager = await PageManager.open({ path: filePath, pageSize: 4096 });
  const pageId = manager.allocatePage();
  manager.writePage(pageId, Buffer.from("safe"));
  await manager.close();

  const bytes = await readFile(filePath);
  bytes[80] = bytes[80]! ^ 0xff;
  await writeFile(filePath, bytes);

  const reopened = await PageManager.open({ path: filePath, pageSize: 4096 });
  await assert.rejects(() => reopened.readPage(pageId), WotonFileError);

  await reopened.close();
  await cleanup(filePath);
});

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtpg`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}-pwal`, { force: true });
}
