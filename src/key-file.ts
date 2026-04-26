import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertUsablePassword,
  createEncryptionKey,
  destroyEncryptionKey,
  type EncryptionKey,
  type KdfEnvelope
} from "./crypto.js";
import { WotonSecurityError } from "./errors.js";

const KEY_FILE_VERSION = 1;
const KDF_SCRYPT = 1;
const CIPHER_AES_256_GCM = 1;
const KEY_HEADER_FIXED_LENGTH = 4 + 1 + 1 + 1 + 2 + 4 + 4 + 4 + 4 + 1;

const SUPPORTED_KDF = {
  name: "scrypt" as const,
  keyLength: 32,
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

export interface KeyFileOptions {
  readonly path: string;
  readonly magic: Buffer;
  readonly password: string | Buffer;
  readonly minPasswordLength: number;
}

export async function openKeyFile(options: KeyFileOptions): Promise<EncryptionKey> {
  assertUsablePassword(options.password, options.minPasswordLength);

  if (await exists(options.path)) {
    return createEncryptionKey(options.password, parseKeyHeader(await fs.readFile(options.path), options.magic));
  }

  const encryptionKey = createEncryptionKey(options.password);

  try {
    await fs.mkdir(path.dirname(options.path), { recursive: true });
    await fs.writeFile(options.path, encodeKeyHeader(encryptionKey.kdf, options.magic), { flag: "wx" });
    await fsyncDirectory(path.dirname(options.path));
    return encryptionKey;
  } catch (error) {
    destroyEncryptionKey(encryptionKey);

    if (await exists(options.path)) {
      return createEncryptionKey(options.password, parseKeyHeader(await fs.readFile(options.path), options.magic));
    }

    throw error;
  }
}

function encodeKeyHeader(kdf: KdfEnvelope, magic: Buffer): Buffer {
  const header = Buffer.allocUnsafe(KEY_HEADER_FIXED_LENGTH + kdf.salt.byteLength);
  let offset = 0;

  magic.copy(header, offset);
  offset += 4;
  header.writeUInt8(KEY_FILE_VERSION, offset);
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
  header.writeUInt8(kdf.salt.byteLength, offset);
  offset += 1;
  kdf.salt.copy(header, offset);

  return header;
}

function parseKeyHeader(bytes: Buffer, magic: Buffer): KdfEnvelope {
  if (bytes.byteLength < KEY_HEADER_FIXED_LENGTH || !bytes.subarray(0, 4).equals(magic)) {
    throw new WotonSecurityError("The encryption key metadata file is not supported.");
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
  const saltEnd = offset + saltLength;

  if (
    version !== KEY_FILE_VERSION ||
    kdfId !== KDF_SCRYPT ||
    cipherId !== CIPHER_AES_256_GCM ||
    keyLength !== SUPPORTED_KDF.keyLength ||
    N !== SUPPORTED_KDF.N ||
    r !== SUPPORTED_KDF.r ||
    p !== SUPPORTED_KDF.p ||
    maxmem !== SUPPORTED_KDF.maxmem ||
    saltLength < 16 ||
    saltEnd !== bytes.byteLength
  ) {
    throw new WotonSecurityError("The encryption key metadata settings are not supported.");
  }

  return {
    ...SUPPORTED_KDF,
    salt: Buffer.from(bytes.subarray(offset, saltEnd))
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
