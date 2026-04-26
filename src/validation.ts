import { WotonValidationError } from "./errors.js";
import type { WotonDocument, WotonValue } from "./types.js";

const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME.test(name)) {
    throw new WotonValidationError(
      `Invalid collection name "${name}". Use letters, numbers, "_", ":" or "-", starting with a letter.`
    );
  }
}

export function assertFieldPath(field: string): void {
  if (!FIELD_PATH.test(field)) {
    throw new WotonValidationError(`Invalid field path "${field}".`);
  }
}

export function assertRecordId(id: string): void {
  if (!RECORD_ID.test(id)) {
    throw new WotonValidationError(`Invalid record id "${id}".`);
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WotonValidationError(`${label} must be a positive integer.`);
  }
}

export function assertDocument(value: unknown): asserts value is WotonDocument {
  if (!isPlainObject(value)) {
    throw new WotonValidationError("Woton records must be plain JSON objects.");
  }

  assertJsonValue(value, "record");
}

function assertJsonValue(value: unknown, path: string): asserts value is WotonValue {
  if (value === null) {
    return;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new WotonValidationError(`${path} must be a finite number.`);
    }

    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`);
    }

    return;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new WotonValidationError(`${path}.${key} cannot be undefined.`);
      }

      assertJsonValue(child, `${path}.${key}`);
    }

    return;
  }

  throw new WotonValidationError(`${path} must contain only JSON-safe values.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
