import assert from "node:assert/strict";
import test from "node:test";
import { decodeDatabaseState } from "../binary-codec.js";
import { compareBytes, crc32, fnv1a32, readVarUint32, scanBytes, varUint32Size, writeVarUint32 } from "../fast-binary.js";

test("binary codec rejects oversized string lengths before allocation", () => {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(8 * 1024 * 1024 + 1, 4);

  assert.throws(() => decodeDatabaseState(bytes, 3), /string bytes/);
});

test("binary codec rejects oversized collection counts", () => {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(0, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(100_001, 12);

  assert.throws(() => decodeDatabaseState(bytes, 3), /collection count/);
});

test("fast binary primitives encode varints and hashes deterministically", () => {
  const values = [0, 1, 127, 128, 16_384, 1_000_000, 0xffffffff];
  const bytes = Buffer.alloc(32);
  let offset = 0;

  for (const value of values) {
    const start = offset;
    offset = writeVarUint32(bytes, offset, value);
    assert.equal(offset - start, varUint32Size(value));
    const decoded = readVarUint32(bytes, start);
    assert.equal(decoded.value, value);
    assert.equal(decoded.offset, offset);
  }

  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(fnv1a32(Buffer.from("woton")), 0xed9a9568);
  assert.equal(compareBytes(Buffer.from("abc"), Buffer.from("abd")) < 0, true);
  assert.equal(scanBytes(Buffer.from("hello woton"), Buffer.from("woton")), 6);
});

test("binary codec still reads legacy v2 record maps", () => {
  const bytes = Buffer.concat([
    u32(1),
    string("2026-01-01T00:00:00.000Z"),
    string("2026-01-01T00:00:00.000Z"),
    u32(1),
    string("users"),
    u32(0),
    u32(0),
    u32(1),
    string("ana"),
    objectValue({
      id: "ana",
      name: "Ana",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })
  ]);

  const state = decodeDatabaseState(bytes, 2);

  assert.equal(state.collections.users?.records.ana?.name, "Ana");
  assert.equal(state.collections.users?.recordCount, 1);
});

function objectValue(values: Record<string, string>): Buffer {
  return Buffer.concat([
    Buffer.from([6]),
    u32(Object.keys(values).length),
    ...Object.entries(values).flatMap(([key, value]) => [string(key), stringValue(value)])
  ]);
}

function stringValue(value: string): Buffer {
  return Buffer.concat([Buffer.from([4]), string(value)]);
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.byteLength), bytes]);
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}
