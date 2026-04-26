import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { decodeDatabaseState, decodeJournalFrame, encodeDatabaseState, encodeJournalFrame } from "./binary-codec.js";
import { WotonSecurityError } from "./errors.js";
import type { JournalFrame } from "./journal.js";
import type { DatabaseState } from "./types.js";

const STATE_MAGIC = Buffer.from("WTDB", "ascii");
const SEALED_MAGIC = Buffer.from("WTSE", "ascii");
const STATE_ENVELOPE_VERSION = 3;
const MIN_STATE_ENVELOPE_VERSION = 2;
const SEALED_VERSION = 1;
const KDF_SCRYPT = 1;
const CIPHER_AES_256_GCM = 1;
const FORMAT_STATE = 1;
const FORMAT_JOURNAL_FRAME = 2;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const STATE_HEADER_FIXED_LENGTH = 4 + 1 + 1 + 1 + 2 + 4 + 4 + 4 + 4 + 1;
const SEALED_HEADER_LENGTH = 4 + 1 + 1 + IV_LENGTH;
const EMPTY_BUFFER = Buffer.alloc(0);

export interface KdfEnvelope {
  readonly name: "scrypt";
  readonly salt: Buffer;
  readonly keyLength: number;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
}

export interface EncryptionKey {
  readonly kdf: KdfEnvelope;
  readonly key: Buffer;
}

export interface EncryptionResult {
  readonly bytes: Buffer;
  readonly kdf: KdfEnvelope;
}

export interface EncryptionProfile {
  readonly serializeMs: number;
  readonly encryptMs: number;
  readonly bytes: number;
}

export interface ProfiledEncryptionResult extends EncryptionResult {
  readonly profile: EncryptionProfile;
}

export interface DecryptionResult {
  readonly state: DatabaseState;
  readonly kdf: KdfEnvelope;
}

export interface EncryptedStateOpenResult extends DecryptionResult {
  readonly encryptionKey: EncryptionKey;
}

export interface BinaryDecryptionResult<T> {
  readonly value: T;
  readonly kdf: KdfEnvelope;
}

const DEFAULT_KDF = {
  name: "scrypt" as const,
  keyLength: 32,
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

export function assertUsablePassword(password: string | Buffer, minLength: number): void {
  const length = typeof password === "string" ? Buffer.byteLength(password, "utf8") : password.byteLength;

  if (length < minLength) {
    throw new WotonSecurityError(`Woton requires a database password with at least ${minLength} bytes.`);
  }
}

export function createEncryptionKey(password: string | Buffer, existingKdf?: KdfEnvelope): EncryptionKey {
  const kdf = existingKdf ?? createKdf();
  return {
    kdf,
    key: deriveKey(password, kdf)
  };
}

export function destroyEncryptionKey(encryptionKey: EncryptionKey | undefined): void {
  encryptionKey?.key.fill(0);
}

export function encryptState(
  state: DatabaseState,
  password: string | Buffer,
  existingKdf?: KdfEnvelope
): EncryptionResult {
  const encryptionKey = createEncryptionKey(password, existingKdf);

  try {
    return encryptStateWithKey(state, encryptionKey);
  } finally {
    destroyEncryptionKey(encryptionKey);
  }
}

export function encryptStateWithKey(state: DatabaseState, encryptionKey: EncryptionKey): EncryptionResult {
  return encryptStateWithKeyProfiled(state, encryptionKey);
}

export function encryptStateWithKeyProfiled(
  state: DatabaseState,
  encryptionKey: EncryptionKey
): ProfiledEncryptionResult {
  const serializeStart = performance.now();
  const payload = encodeDatabaseState(state);
  const serializeMs = performance.now() - serializeStart;
  const encryptStart = performance.now();
  const header = encodeStateHeader(encryptionKey.kdf);
  const bytes = sealPayload(payload, encryptionKey.key, FORMAT_STATE, header, header);
  const encryptMs = performance.now() - encryptStart;

  return {
    bytes,
    kdf: encryptionKey.kdf,
    profile: {
      serializeMs,
      encryptMs,
      bytes: bytes.byteLength
    }
  };
}

export function decryptState(bytes: Buffer, password: string | Buffer): DecryptionResult {
  const result = openEncryptedState(bytes, password);

  try {
    return {
      state: result.state,
      kdf: result.kdf
    };
  } finally {
    destroyEncryptionKey(result.encryptionKey);
  }
}

export function openEncryptedState(bytes: Buffer, password: string | Buffer): EncryptedStateOpenResult {
  const parsed = parseStateEnvelope(bytes);
  let encryptionKey: EncryptionKey | undefined;

  try {
    encryptionKey = createEncryptionKey(password, parsed.kdf);
    const payload = openSealedPayload(parsed.sealed, encryptionKey.key, FORMAT_STATE, parsed.header);

    return {
      state: decodeDatabaseState(payload, parsed.version),
      kdf: parsed.kdf,
      encryptionKey
    };
  } catch (error) {
    destroyEncryptionKey(encryptionKey);
    throw securityError("Could not decrypt the .wtdb file. Check the password or file integrity.", error);
  }
}

export function encryptJournalFrameWithKey(frame: JournalFrame, encryptionKey: EncryptionKey): EncryptionResult {
  return {
    bytes: sealPayload(encodeJournalFrame(frame), encryptionKey.key, FORMAT_JOURNAL_FRAME),
    kdf: encryptionKey.kdf
  };
}

export function decryptJournalFrameWithKey(bytes: Buffer, encryptionKey: EncryptionKey): BinaryDecryptionResult<JournalFrame> {
  try {
    return {
      value: decodeJournalFrame(openSealedPayload(bytes, encryptionKey.key, FORMAT_JOURNAL_FRAME)),
      kdf: encryptionKey.kdf
    };
  } catch (error) {
    throw securityError("Could not decrypt the WAL frame. Check the password or file integrity.", error);
  }
}

export function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBytes, rightBytes);
}

function deriveKey(password: string | Buffer, kdf: KdfEnvelope): Buffer {
  return scryptSync(password, kdf.salt, kdf.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: kdf.maxmem
  });
}

function createKdf(): KdfEnvelope {
  return {
    ...DEFAULT_KDF,
    salt: randomBytes(16)
  };
}

function sealPayload(
  payload: Buffer,
  key: Buffer,
  format: number,
  extraAad: Buffer = EMPTY_BUFFER,
  outputPrefix: Buffer = EMPTY_BUFFER
): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const header = Buffer.allocUnsafe(SEALED_HEADER_LENGTH);
  SEALED_MAGIC.copy(header, 0);
  header.writeUInt8(SEALED_VERSION, 4);
  header.writeUInt8(format, 5);
  iv.copy(header, 6);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(extraAad, header));
  const encrypted = cipher.update(payload);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const parts = outputPrefix.byteLength > 0
    ? [outputPrefix, header, tag, encrypted]
    : [header, tag, encrypted];

  if (final.byteLength > 0) {
    parts.push(final);
  }

  return Buffer.concat(parts, outputPrefix.byteLength + header.byteLength + tag.byteLength + encrypted.byteLength + final.byteLength);
}

function openSealedPayload(bytes: Buffer, key: Buffer, expectedFormat: number, extraAad: Buffer = EMPTY_BUFFER): Buffer {
  if (bytes.byteLength < SEALED_HEADER_LENGTH + TAG_LENGTH) {
    throw new WotonSecurityError("The encrypted payload is truncated.");
  }

  if (!bytes.subarray(0, 4).equals(SEALED_MAGIC)) {
    throw new WotonSecurityError("The encrypted payload format is not supported.");
  }

  const version = bytes.readUInt8(4);
  const format = bytes.readUInt8(5);

  if (version !== SEALED_VERSION || format !== expectedFormat) {
    throw new WotonSecurityError("The encrypted payload format is not supported.");
  }

  const header = bytes.subarray(0, SEALED_HEADER_LENGTH);
  const iv = bytes.subarray(6, 6 + IV_LENGTH);
  const tag = bytes.subarray(SEALED_HEADER_LENGTH, SEALED_HEADER_LENGTH + TAG_LENGTH);
  const encrypted = bytes.subarray(SEALED_HEADER_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(extraAad, header));
  decipher.setAuthTag(tag);

  const decrypted = decipher.update(encrypted);
  const final = decipher.final();

  return final.byteLength === 0 ? decrypted : Buffer.concat([decrypted, final]);
}

function aad(extraAad: Buffer, sealedHeader: Buffer): Buffer {
  return extraAad.byteLength === 0 ? sealedHeader : Buffer.concat([extraAad, sealedHeader]);
}

function encodeStateHeader(kdf: KdfEnvelope): Buffer {
  const salt = kdf.salt;
  const header = Buffer.allocUnsafe(STATE_HEADER_FIXED_LENGTH + salt.byteLength);
  let offset = 0;

  STATE_MAGIC.copy(header, offset);
  offset += 4;
  header.writeUInt8(STATE_ENVELOPE_VERSION, offset);
  offset += 1;
  header.writeUInt8(KDF_SCRYPT, offset);
  offset += 1;
  header.writeUInt8(CIPHER_AES_256_GCM, offset);
  offset += 1;
  header.writeUInt16LE(kdf.keyLength, offset);
  offset += 2;
  header.writeUInt32LE(kdf.N, offset);
  offset += 4;
  header.writeUInt32LE(kdf.r, offset);
  offset += 4;
  header.writeUInt32LE(kdf.p, offset);
  offset += 4;
  header.writeUInt32LE(kdf.maxmem, offset);
  offset += 4;
  header.writeUInt8(salt.byteLength, offset);
  offset += 1;
  salt.copy(header, offset);

  return header;
}

function parseStateEnvelope(bytes: Buffer): {
  readonly version: number;
  readonly kdf: KdfEnvelope;
  readonly header: Buffer;
  readonly sealed: Buffer;
} {
  if (bytes.byteLength < STATE_HEADER_FIXED_LENGTH + SEALED_HEADER_LENGTH + TAG_LENGTH) {
    throw new WotonSecurityError("The .wtdb file is not a valid Woton encrypted database.");
  }

  if (!bytes.subarray(0, 4).equals(STATE_MAGIC)) {
    throw new WotonSecurityError("The .wtdb file format is not supported by this Woton version.");
  }

  let offset = 4;
  const version = bytes.readUInt8(offset);
  offset += 1;
  const kdfId = bytes.readUInt8(offset);
  offset += 1;
  const cipherId = bytes.readUInt8(offset);
  offset += 1;
  const keyLength = bytes.readUInt16LE(offset);
  offset += 2;
  const N = bytes.readUInt32LE(offset);
  offset += 4;
  const r = bytes.readUInt32LE(offset);
  offset += 4;
  const p = bytes.readUInt32LE(offset);
  offset += 4;
  const maxmem = bytes.readUInt32LE(offset);
  offset += 4;
  const saltLength = bytes.readUInt8(offset);
  offset += 1;

  if (
    version < MIN_STATE_ENVELOPE_VERSION ||
    version > STATE_ENVELOPE_VERSION ||
    kdfId !== KDF_SCRYPT ||
    cipherId !== CIPHER_AES_256_GCM ||
    keyLength !== DEFAULT_KDF.keyLength ||
    N !== DEFAULT_KDF.N ||
    r !== DEFAULT_KDF.r ||
    p !== DEFAULT_KDF.p ||
    maxmem !== DEFAULT_KDF.maxmem
  ) {
    throw new WotonSecurityError("The .wtdb encryption settings are not supported.");
  }

  if (offset + saltLength >= bytes.byteLength) {
    throw new WotonSecurityError("The .wtdb file is not a valid Woton encrypted database.");
  }

  const headerEnd = offset + saltLength;
  const salt = bytes.subarray(offset, headerEnd);
  const kdf: KdfEnvelope = {
    name: "scrypt",
    salt: Buffer.from(salt),
    keyLength,
    N,
    r,
    p,
    maxmem
  };

  return {
    version,
    kdf,
    header: bytes.subarray(0, headerEnd),
    sealed: bytes.subarray(headerEnd)
  };
}

function securityError(message: string, cause: unknown): WotonSecurityError {
  return cause instanceof WotonSecurityError
    ? cause
    : new WotonSecurityError(message, { cause });
}
