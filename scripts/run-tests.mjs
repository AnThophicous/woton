import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const testRoot = join(process.cwd(), "dist", "__tests__");

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

const testFiles = await collectTestFiles(testRoot);

if (testFiles.length === 0) {
  console.error(`No compiled test files found in ${testRoot}`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test process exited with signal ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
