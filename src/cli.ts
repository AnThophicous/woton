#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Woton } from "./index.js";

async function main(): Promise<void> {
  const [filePath, ...commandParts] = process.argv.slice(2);
  const password = process.env.WOTON_PASSWORD;

  if (!filePath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!password) {
    console.error("Set WOTON_PASSWORD before opening a database.");
    process.exitCode = 1;
    return;
  }

  const command = commandParts.length > 0 ? commandParts.join(" ") : (await readStdin()).trim();

  if (!command) {
    console.error("Provide a Woton command as an argument or through stdin.");
    process.exitCode = 1;
    return;
  }

  const db = await Woton.open({ path: filePath, password });

  try {
    const result = await db.query(command);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.close();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function printUsage(): void {
  console.error(`Usage:
  WOTON_PASSWORD="strong password" woton ./data.wtdb "from users limit 10"
  WOTON_PASSWORD="strong password" woton ./data.wtdb < commands.woton`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
