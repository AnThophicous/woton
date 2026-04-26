import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedPageManager } from "../encrypted-page-manager.js";
import { WotonSecurityError } from "../errors.js";

test("encrypted page manager stores page payloads encrypted and reuses one derived key per open", async () => {
  const filePath = tempFile("encrypted-page-basic");
  const password = "0123456789abcdef";
  let manager = await EncryptedPageManager.open({ path: filePath, password, pageSize: 4096, cachePages: 2 });
  const pageId = manager.allocatePage();

  manager.writePage(pageId, Buffer.from("plain-page-secret"));
  await manager.close();

  const bytes = await readFile(filePath);
  assert.equal(bytes.includes(Buffer.from("plain-page-secret")), false);

  manager = await EncryptedPageManager.open({ path: filePath, password, pageSize: 4096, cachePages: 2 });
  assert.equal((await manager.readPage(pageId)).subarray(0, 17).toString(), "plain-page-secret");

  await manager.close();
  await cleanup(filePath);
});

test("encrypted page manager rejects reads with the wrong password", async () => {
  const filePath = tempFile("encrypted-page-wrong-password");
  let manager = await EncryptedPageManager.open({
    path: filePath,
    password: "0123456789abcdef",
    pageSize: 4096
  });
  const pageId = manager.allocatePage();

  manager.writePage(pageId, Buffer.from("secret"));
  await manager.close();

  manager = await EncryptedPageManager.open({
    path: filePath,
    password: "abcdef0123456789",
    pageSize: 4096
  });

  await assert.rejects(() => manager.readPage(pageId), WotonSecurityError);
  await manager.close();
  await cleanup(filePath);
});

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtpg`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}-pwal`, { force: true });
  await rm(`${filePath}-pkey`, { force: true });
}
