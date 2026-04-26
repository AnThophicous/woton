import assert from "node:assert/strict";
import test from "node:test";
import { WotonError } from "../errors.js";
import { parseLanguage } from "../language.js";

const seed = 0x5eed1234;

test("deterministically fuzzes valid Woton language commands", () => {
  const random = prng(seed);
  const collections = ["users", "audit_logs", "session:events", "tenant-1"];
  const fields = ["name", "age", "active", "profile.email", "roles"];
  const ids = ["ana", "user_42", "session-1", "tenant:root"];
  const operators = ["=", "==", "!=", ">", ">=", "<", "<=", "contains", "startsWith", "endsWith", "in"];

  for (let index = 0; index < 400; index += 1) {
    const collection = pick(random, collections);
    const field = pick(random, fields);
    const id = pick(random, ids);
    const value = pick(random, ["true", "false", "null", "27", "\"Ana\"", "'Bia'", "[\"admin\",\"reader\"]"]);
    const operator = pick(random, operators);
    const command = pick(random, [
      `make ${collection}`,
      `drop ${collection}`,
      `index ${collection} ${field}`,
      `unindex ${collection} ${field}`,
      `put ${collection} ${JSON.stringify({ id, name: "Ana", age: 27, active: true })}`,
      `get ${collection} ${id}`,
      `set ${collection} ${id} ${JSON.stringify({ active: false, age: index })}`,
      `del ${collection} ${id}`,
      `from ${collection} where ${field} ${operator} ${value} sort ${field} asc limit ${1 + (index % 25)} offset ${index % 5}`,
      `count ${collection} where ${field} ${operator} ${value}`
    ]);

    const parsed = parseLanguage(command);
    assert.equal(typeof parsed.type, "string");
    assert.equal(typeof parsed.collection, "string");
  }
});

test("deterministically fuzzes malformed Woton language commands", () => {
  const random = prng(seed ^ 0xffffffff);
  const fragments = [
    "",
    " ",
    "\0",
    "unknown users",
    "make",
    "make users extra",
    "index users",
    "index 9users name",
    "put users",
    "put users []",
    "put users {",
    "set users id",
    "set users invalid id {}",
    "from users where",
    "from users where age approximately 18",
    "from users limit -1",
    "count users sort age sideways"
  ];
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_:-{}[]\"' .,<>!=\n\t";

  for (let index = 0; index < 300; index += 1) {
    const base = pick(random, fragments);
    const noise = randomString(random, alphabet, index % 23);
    const input = index % 2 === 0 ? `${base}${noise}` : `${noise}${base}`;

    try {
      parseLanguage(input);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof WotonError || error.name === "SyntaxError");
    }
  }
});

function prng(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function randomString(random: () => number, alphabet: string, length: number): string {
  let value = "";

  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(random() * alphabet.length)];
  }

  return value;
}
