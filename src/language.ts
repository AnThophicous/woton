import { WotonQueryError } from "./errors.js";
import type { QueryCondition, QueryOperator, QuerySpec, SortDirection, WotonDocument, WotonValue } from "./types.js";
import { assertCollectionName, assertFieldPath, assertPositiveInteger, assertRecordId } from "./validation.js";

export type LanguageCommand =
  | { readonly type: "make"; readonly collection: string }
  | { readonly type: "drop"; readonly collection: string }
  | { readonly type: "index"; readonly collection: string; readonly field: string }
  | { readonly type: "unindex"; readonly collection: string; readonly field: string }
  | { readonly type: "put"; readonly collection: string; readonly document: WotonDocument }
  | { readonly type: "get"; readonly collection: string; readonly id: string }
  | { readonly type: "set"; readonly collection: string; readonly id: string; readonly patch: WotonDocument }
  | { readonly type: "del"; readonly collection: string; readonly id: string }
  | { readonly type: "from"; readonly collection: string; readonly spec: QuerySpec }
  | { readonly type: "count"; readonly collection: string; readonly spec: QuerySpec };

const OPERATORS = new Set<QueryOperator>([
  "=",
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "startsWith",
  "endsWith",
  "in"
]);

export function parseLanguage(input: string): LanguageCommand {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new WotonQueryError("Empty Woton command.");
  }

  const [verb] = trimmed.split(/\s+/, 1);

  switch (verb.toLowerCase()) {
    case "make":
      return parseSingleName(trimmed, "make");
    case "drop":
      return parseSingleName(trimmed, "drop");
    case "index":
      return parseIndex(trimmed, "index");
    case "unindex":
      return parseIndex(trimmed, "unindex");
    case "put":
      return parsePut(trimmed);
    case "get":
      return parseRecordId(trimmed, "get");
    case "set":
      return parseSet(trimmed);
    case "del":
    case "delete":
      return { ...parseRecordId(trimmed, verb.toLowerCase()), type: "del" };
    case "from":
      return parseFrom(trimmed, false);
    case "count":
      return parseFrom(trimmed, true);
    default:
      throw new WotonQueryError(`Unknown Woton command "${verb}".`);
  }
}

function parseSingleName(input: string, type: "make" | "drop"): LanguageCommand {
  const tokens = tokenize(input);

  if (tokens.length !== 2) {
    throw new WotonQueryError(`${type} expects exactly one collection name.`);
  }

  assertCollectionName(tokens[1]);
  return { type, collection: tokens[1] };
}

function parseIndex(input: string, type: "index" | "unindex"): LanguageCommand {
  const tokens = tokenize(input);

  if (tokens.length !== 3) {
    throw new WotonQueryError(`${type} expects: ${type} collection field`);
  }

  assertCollectionName(tokens[1]);
  assertFieldPath(tokens[2]);
  return { type, collection: tokens[1], field: tokens[2] };
}

function parsePut(input: string): LanguageCommand {
  const match = /^put\s+([A-Za-z][A-Za-z0-9_:-]{0,63})\s+([\s\S]+)$/i.exec(input);

  if (!match) {
    throw new WotonQueryError("put expects: put collection { json }");
  }

  const collection = match[1];
  assertCollectionName(collection);
  return {
    type: "put",
    collection,
    document: parseJsonDocument(match[2])
  };
}

function parseSet(input: string): LanguageCommand {
  const match = /^set\s+([A-Za-z][A-Za-z0-9_:-]{0,63})\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\s+([\s\S]+)$/i.exec(input);

  if (!match) {
    throw new WotonQueryError("set expects: set collection id { json }");
  }

  const collection = match[1];
  const id = match[2];
  assertCollectionName(collection);
  assertRecordId(id);

  return {
    type: "set",
    collection,
    id,
    patch: parseJsonDocument(match[3])
  };
}

function parseRecordId(input: string, type: string): { readonly type: "get" | "del"; readonly collection: string; readonly id: string } {
  const tokens = tokenize(input);

  if (tokens.length !== 3) {
    throw new WotonQueryError(`${type} expects: ${type} collection id`);
  }

  assertCollectionName(tokens[1]);
  assertRecordId(tokens[2]);
  return {
    type: type === "get" ? "get" : "del",
    collection: tokens[1],
    id: tokens[2]
  };
}

function parseFrom(input: string, count: boolean): LanguageCommand {
  const tokens = tokenize(input);

  if (tokens.length < 2) {
    throw new WotonQueryError(count ? "count expects: count collection" : "from expects: from collection");
  }

  const collection = tokens[1];
  assertCollectionName(collection);

  const spec = parseQuerySpec(tokens.slice(2), count);
  return {
    type: count ? "count" : "from",
    collection,
    spec
  };
}

function parseQuerySpec(tokens: string[], count: boolean): QuerySpec {
  const conditions: QueryCondition[] = [];
  let orderBy: QuerySpec["orderBy"];
  let limit: number | undefined;
  let offset: number | undefined;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]?.toLowerCase();

    if (token === "where" || token === "and") {
      const field = tokens[index + 1];
      const operator = tokens[index + 2] as QueryOperator | undefined;
      const valueToken = tokens[index + 3];

      if (!field || !operator || !valueToken || !OPERATORS.has(operator)) {
        throw new WotonQueryError("Invalid where clause.");
      }

      assertFieldPath(field);
      conditions.push({
        field,
        operator,
        value: parseValue(valueToken)
      });
      index += 4;
      continue;
    }

    if (token === "sort" || token === "order") {
      const field = tokens[index + 1];
      const direction = (tokens[index + 2]?.toLowerCase() ?? "asc") as SortDirection;

      if (!field || (direction !== "asc" && direction !== "desc")) {
        throw new WotonQueryError("sort expects: sort field asc|desc");
      }

      assertFieldPath(field);
      orderBy = { field, direction };
      index += tokens[index + 2] ? 3 : 2;
      continue;
    }

    if (token === "limit" || token === "take") {
      limit = parseNumber(tokens[index + 1], token);
      index += 2;
      continue;
    }

    if (token === "offset" || token === "skip") {
      offset = parseNumber(tokens[index + 1], token);
      index += 2;
      continue;
    }

    throw new WotonQueryError(`Unexpected token "${tokens[index]}".`);
  }

  return {
    conditions,
    orderBy,
    limit,
    offset,
    count
  };
}

function parseNumber(value: string | undefined, label: string): number {
  const number = Number(value);
  assertPositiveInteger(number, label);
  return number;
}

function parseJsonDocument(value: string): WotonDocument {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new WotonQueryError("JSON payload must be an object.");
    }

    return parsed as WotonDocument;
  } catch (error) {
    if (error instanceof WotonQueryError) {
      throw error;
    }

    throw new WotonQueryError("Invalid JSON payload.", { cause: error });
  }
}

function parseValue(token: string): WotonValue {
  if (token.startsWith("\"") || token.startsWith("'")) {
    return parseQuotedString(token);
  }

  if (token === "true") {
    return true;
  }

  if (token === "false") {
    return false;
  }

  if (token === "null") {
    return null;
  }

  if (token.startsWith("[") || token.startsWith("{")) {
    try {
      return JSON.parse(token) as WotonValue;
    } catch (error) {
      throw new WotonQueryError(`Invalid JSON value "${token}".`, { cause: error });
    }
  }

  const number = Number(token);
  return Number.isNaN(number) ? token : number;
}

function parseQuotedString(token: string): string {
  if (token.startsWith("\"")) {
    return JSON.parse(token) as string;
  }

  if (!token.endsWith("'")) {
    throw new WotonQueryError(`Invalid string value "${token}".`);
  }

  return token.slice(1, -1);
}

function tokenize(input: string): string[] {
  return input.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\[[^\]]*\]|\S+/g) ?? [];
}
