import type { QueryCondition, QuerySpec, WotonRecord, WotonValue } from "./types.js";

export type QueryEngineResult = WotonRecord[] | number;

export function runQuery(records: readonly WotonRecord[], spec: QuerySpec): QueryEngineResult {
  let result = records.filter((record) => spec.conditions.every((condition) => matchesCondition(record, condition)));

  if (spec.orderBy) {
    const { field, direction } = spec.orderBy;
    const multiplier = direction === "asc" ? 1 : -1;

    result = [...result].sort((left, right) => compareValues(getByPath(left, field), getByPath(right, field)) * multiplier);
  }

  if (spec.count) {
    return result.length;
  }

  const offset = spec.offset ?? 0;
  const limited = typeof spec.limit === "number" ? result.slice(offset, offset + spec.limit) : result.slice(offset);

  return limited;
}

export function matchesCondition(record: WotonRecord, condition: QueryCondition): boolean {
  const left = getByPath(record, condition.field);
  const right = condition.value;

  switch (condition.operator) {
    case "=":
    case "==":
      return valuesEqual(left, right);
    case "!=":
      return !valuesEqual(left, right);
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
    case "contains":
      return containsValue(left, right);
    case "startsWith":
      return typeof left === "string" && typeof right === "string" && left.startsWith(right);
    case "endsWith":
      return typeof left === "string" && typeof right === "string" && left.endsWith(right);
    case "in":
      return Array.isArray(right) && right.some((item) => valuesEqual(left, item));
  }
}

export function getByPath(value: WotonRecord | WotonValue | undefined, path: string): WotonValue | undefined {
  const parts = path.split(".");
  let current: unknown = value;

  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current as WotonValue | undefined;
}

export function indexKey(value: WotonValue | undefined): string {
  return JSON.stringify(value ?? null);
}

function valuesEqual(left: WotonValue | undefined, right: WotonValue): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

function containsValue(left: WotonValue | undefined, right: WotonValue): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return left.includes(right);
  }

  if (Array.isArray(left)) {
    return left.some((item) => valuesEqual(item, right));
  }

  return false;
}

function compareValues(left: WotonValue | undefined, right: WotonValue | undefined): number {
  if (left === undefined && right === undefined) {
    return 0;
  }

  if (left === undefined) {
    return -1;
  }

  if (right === undefined) {
    return 1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }

  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
