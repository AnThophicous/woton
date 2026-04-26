const CRC32_TABLE = createCrc32Table();
const FNV1A_OFFSET = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

export interface VarUint32ReadResult {
  readonly value: number;
  readonly offset: number;
}

export function crc32(bytes: Buffer | Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;

  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = (CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function fnv1a32(bytes: Buffer | Uint8Array, seed = FNV1A_OFFSET): number {
  let hash = seed >>> 0;

  for (let index = 0; index < bytes.byteLength; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }

  return hash >>> 0;
}

export function varUint32Size(value: number): number {
  assertUint32(value);

  if (value < 0x80) {
    return 1;
  }

  if (value < 0x4000) {
    return 2;
  }

  if (value < 0x20_0000) {
    return 3;
  }

  if (value < 0x1000_0000) {
    return 4;
  }

  return 5;
}

export function writeVarUint32(target: Buffer, offset: number, value: number): number {
  assertUint32(value);
  let current = value >>> 0;
  let cursor = offset;

  while (current >= 0x80) {
    target[cursor] = (current & 0x7f) | 0x80;
    current >>>= 7;
    cursor += 1;
  }

  target[cursor] = current;
  return cursor + 1;
}

export function readVarUint32(source: Buffer, offset: number): VarUint32ReadResult {
  let value = 0;
  let shift = 0;

  for (let index = 0; index < 5; index += 1) {
    const cursor = offset + index;

    if (cursor >= source.byteLength) {
      throw new Error("Binary varint is truncated.");
    }

    const byte = source[cursor]!;
    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return {
        value: value >>> 0,
        offset: cursor + 1
      };
    }

    shift += 7;
  }

  throw new Error("Binary varint exceeds uint32.");
}

export function compareBytes(left: Buffer | Uint8Array, right: Buffer | Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);

  for (let index = 0; index < length; index += 1) {
    const delta = left[index]! - right[index]!;

    if (delta !== 0) {
      return delta;
    }
  }

  return left.byteLength - right.byteLength;
}

export function scanBytes(source: Buffer, needle: Buffer, offset = 0): number {
  return source.indexOf(needle, offset);
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

function assertUint32(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("Binary varint value must be uint32.");
  }
}
