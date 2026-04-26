import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Woton, WotonSecurityError } from "../index.js";

const password = "correct horse battery staple";
const wrongPassword = "correct horse battery staple but wrong";
const secretEmail = "secret.ana@example.com";
const secretNote = "plaintext must stay encrypted";

test("deterministically fuzzes corrupted .wtdb files", async () => {
  const sourcePath = await createFixture("corrupt-fuzz");
  const original = await readFile(sourcePath);
  const cases = corruptions(original);

  try {
    for (const [name, bytes] of cases) {
      const filePath = tempFile(`corrupt-${name}`);
      await writeFile(filePath, bytes);

      await assertRejectsWithoutPlaintext(filePath, password);
      assertNoPlaintext(bytes);
      await cleanup(filePath);
    }
  } finally {
    await cleanup(sourcePath);
  }
});

test("keeps valid database intact when stale temporary files exist", async () => {
  const filePath = await createFixture("stale-temp");
  const tempPath = `${filePath}.${process.pid}.999999.tmp`;

  try {
    await writeFile(tempPath, Buffer.from(secretNote, "utf8"));

    const db = await Woton.open({ path: filePath, password });
    const record = await db.collection<{ email: string; note: string }>("users").get("ana");
    await db.close();

    assert.equal(record?.email, secretEmail);
    assert.equal(record?.note, secretNote);
  } finally {
    await rm(tempPath, { force: true });
    await cleanup(filePath);
  }
});

test("wrong password and truncation fail without exposing plaintext", async () => {
  const filePath = await createFixture("wrong-password-integrity");
  const original = await readFile(filePath);
  const truncatedPath = tempFile("truncated");

  try {
    await assertRejectsWithoutPlaintext(filePath, wrongPassword);
    assertNoPlaintext(original);

    await writeFile(truncatedPath, original.subarray(0, Math.max(1, Math.floor(original.length / 2))));
    await assertRejectsWithoutPlaintext(truncatedPath, password);
    assertNoPlaintext(await readFile(truncatedPath));
  } finally {
    await cleanup(filePath);
    await cleanup(truncatedPath);
  }
});

async function createFixture(label: string): Promise<string> {
  const filePath = tempFile(label);
  const db = await Woton.open({ path: filePath, password });

  await db.collection<{ email: string; note: string; active: boolean }>("users").insert({
    id: "ana",
    email: secretEmail,
    note: secretNote,
    active: true
  });
  await db.close();

  return filePath;
}

function corruptions(original: Buffer): Array<[string, Buffer]> {
  const cases: Array<[string, Buffer]> = [
    ["empty", Buffer.alloc(0)],
    ["single-byte", Buffer.from([0])],
    ["not-binary", Buffer.from("not a woton database", "utf8")],
    ["truncated-header", original.subarray(0, 12)],
    ["truncated-half", original.subarray(0, Math.floor(original.length / 2))]
  ];

  for (const offset of deterministicOffsets(original.length)) {
    const mutated = Buffer.from(original);
    mutated[offset] = mutated[offset]! ^ 0x5a;
    cases.push([`flip-${offset}`, mutated]);
  }

  cases.push(["bad-magic", replacing(original, 0, Buffer.from("NOPE", "ascii"))]);
  cases.push(["bad-version", flipping(original, 4)]);
  cases.push(["bad-kdf", flipping(original, 5)]);
  cases.push(["bad-payload", flipping(original, original.length - 1)]);

  return cases;
}

function replacing(original: Buffer, offset: number, replacement: Buffer): Buffer {
  const mutated = Buffer.from(original);
  replacement.copy(mutated, offset);
  return mutated;
}

function flipping(original: Buffer, offset: number): Buffer {
  const mutated = Buffer.from(original);
  mutated[offset] = mutated[offset]! ^ 0x5a;
  return mutated;
}

function deterministicOffsets(length: number): number[] {
  const offsets = new Set<number>();
  let state = 0x9e3779b9;

  while (offsets.size < Math.min(24, length)) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    offsets.add(state % length);
  }

  return [...offsets].sort((left, right) => left - right);
}

async function assertRejectsWithoutPlaintext(filePath: string, attemptPassword: string): Promise<void> {
  await assert.rejects(async () => {
    await Woton.open({ path: filePath, password: attemptPassword });
  }, (error: unknown) => {
    assert.ok(error instanceof WotonSecurityError);
    assertNoPlaintext(Buffer.from(String(error), "utf8"));
    return true;
  });
}

function assertNoPlaintext(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  assert.equal(text.includes(secretEmail), false);
  assert.equal(text.includes(secretNote), false);
}

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtdb`);
}

async function cleanup(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}.lock`, { force: true });
  await rm(`${filePath}-lock`, { force: true });
  await rm(`${filePath}-wal`, { force: true });
}
