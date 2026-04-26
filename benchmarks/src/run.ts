import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Woton as WotonClass, WotonCheckpointProfile } from "../../dist/index.js";

type BenchRecord = {
  id: string;
  name: string;
  email: string;
  age: number;
  active: boolean;
  bucket: string;
  score: number;
  tags: string[];
};

type MemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
};

type Measurement = {
  ms: number;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
};

type ScenarioResult = {
  records: number;
  databasePath: string;
  keptDatabaseFile: boolean;
  measurements: {
    insertBatchAutosaveFalse: Measurement & { inserted: number };
    flush: Measurement;
    reopen: Measurement;
    getById: Measurement & { operations: number; found: number };
    queryNoIndex: Measurement & { matched: number; field: string };
    createIndex: Measurement & { field: string };
    queryWithIndex: Measurement & { matched: number; field: string };
    count: Measurement & { counted: number };
  };
  checkpointProfile?: WotonCheckpointProfile;
  fileSizeBytes: number;
  memoryFinal: MemorySnapshot;
};

type BenchmarkResult = {
  name: "woton-dist-benchmark";
  createdAt: string;
  packageEntry: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  cpuCount: number;
  totalMemoryBytes: number;
  options: {
    includeOneMillion: boolean;
    keepFiles: boolean;
    outputDir: string;
    tempDir: string;
    sizes: number[];
    getSamples: number;
  };
  scenarios: ScenarioResult[];
};

type CliOptions = BenchmarkResult["options"];

const password = "benchmark password for local Woton measurements";
const collectionName = "records";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);

  assertDistExists();
  const { Woton } = await import("../../dist/index.js");

  await mkdir(options.outputDir, { recursive: true });
  await mkdir(options.tempDir, { recursive: true });

  const result: BenchmarkResult = {
    name: "woton-dist-benchmark",
    createdAt: new Date().toISOString(),
    packageEntry: path.resolve("dist/index.js"),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    options,
    scenarios: []
  };

  console.log("Woton benchmark against dist");
  console.log(`Node: ${result.node} ${result.platform}/${result.arch}`);
  console.log(`Sizes: ${options.sizes.map(formatNumber).join(", ")}`);
  console.log("");

  for (const size of options.sizes) {
    result.scenarios.push(await runScenario(size, options, Woton));
  }

  const outputFile = path.join(options.outputDir, `woton-benchmark-${safeTimestamp(result.createdAt)}.json`);
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`JSON: ${outputFile}`);
}

async function runScenario(size: number, options: CliOptions, Woton: typeof WotonClass): Promise<ScenarioResult> {
  const databasePath = path.join(options.tempDir, `woton-benchmark-${process.pid}-${size}-${Date.now()}.wtdb`);
  let db = await Woton.open({
    path: databasePath,
    password,
    autosave: false
  });
  const collection = db.collection<BenchRecord>(collectionName);

  console.log(`Scenario ${formatNumber(size)} records`);

  const insertBatchAutosaveFalse = await measureStep("insert autosave:false", async () => {
    for (let index = 0; index < size; index += 1) {
      await collection.insert(makeRecord(index));
    }
  });

  console.log(`  ${"insert rate".padEnd(22)} ${formatRate(size, insertBatchAutosaveFalse.ms)}/s`);

  const flush = await measureStep("flush", async () => {
    await db.flush();
  });

  const statsAfterFlush = await db.stats();
  if (statsAfterFlush.lastCheckpoint) {
    printCheckpointProfile(statsAfterFlush.lastCheckpoint);
  }
  await db.close();

  const reopen = await measureStep("reopen", async () => {
    db = await Woton.open({
      path: databasePath,
      password,
      autosave: false
    });
  });

  const reopenedCollection = db.collection<BenchRecord>(collectionName);
  const ids = sampleIds(size, options.getSamples);
  let found = 0;
  const getById = await measureStep("get by id", async () => {
    for (const id of ids) {
      if (await reopenedCollection.get(id)) {
        found += 1;
      }
    }
  });

  let noIndexMatches = 0;
  const queryNoIndex = await measureStep("query no index", async () => {
    noIndexMatches = (await reopenedCollection.where("bucket", "bucket-042").find()).length;
  });

  const createIndex = await measureStep("create index", async () => {
    await reopenedCollection.index("bucket");
  });

  let indexedMatches = 0;
  const queryWithIndex = await measureStep("query with index", async () => {
    indexedMatches = (await reopenedCollection.where("bucket", "bucket-042").find()).length;
  });

  let counted = 0;
  const count = await measureStep("count", async () => {
    counted = await reopenedCollection.count();
  });

  await db.close();

  if (!options.keepFiles) {
    await cleanup(databasePath);
  }
  collectGarbage();

  const scenario: ScenarioResult = {
    records: size,
    databasePath,
    keptDatabaseFile: options.keepFiles,
    measurements: {
      insertBatchAutosaveFalse: { ...insertBatchAutosaveFalse, inserted: size },
      flush,
      reopen,
      getById: { ...getById, operations: ids.length, found },
      queryNoIndex: { ...queryNoIndex, matched: noIndexMatches, field: "bucket" },
      createIndex: { ...createIndex, field: "bucket" },
      queryWithIndex: { ...queryWithIndex, matched: indexedMatches, field: "bucket" },
      count: { ...count, counted }
    },
    ...(statsAfterFlush.lastCheckpoint ? { checkpointProfile: statsAfterFlush.lastCheckpoint } : {}),
    fileSizeBytes: statsAfterFlush.fileSizeBytes,
    memoryFinal: memorySnapshot()
  };

  printScenario(scenario);
  return scenario;
}

async function measureStep(label: string, operation: () => Promise<void>): Promise<Measurement> {
  const measurement = await measure(operation);
  console.log(`  ${label.padEnd(22)} ${formatMs(measurement.ms)}`);
  return measurement;
}

async function measure(operation: () => Promise<void>): Promise<Measurement> {
  const memoryBefore = memorySnapshot();
  const start = performance.now();
  await operation();
  const ms = performance.now() - start;
  const memoryAfter = memorySnapshot();

  return {
    ms,
    memoryBefore,
    memoryAfter
  };
}

function makeRecord(index: number): BenchRecord {
  const padded = String(index).padStart(9, "0");

  return {
    id: `rec-${padded}`,
    name: `Record ${padded}`,
    email: `record-${padded}@example.test`,
    age: 18 + (index % 70),
    active: index % 2 === 0,
    bucket: `bucket-${String(index % 1_000).padStart(3, "0")}`,
    score: (index * 37) % 10_000,
    tags: [`t${index % 10}`, `g${index % 25}`]
  };
}

function sampleIds(size: number, maxSamples: number): string[] {
  const sampleCount = Math.min(size, maxSamples);
  const ids: string[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const recordIndex = Math.floor((index * size) / sampleCount);
    ids.push(`rec-${String(recordIndex).padStart(9, "0")}`);
  }

  return ids;
}

function parseOptions(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const includeOneMillion = args.includes("--include-1m") || env.WOTON_BENCH_INCLUDE_1M === "1";
  const keepFiles = args.includes("--keep-files") || env.WOTON_BENCH_KEEP_FILES === "1";
  const smoke = args.includes("--smoke");
  const sizesFromCli = valueFor(args, "--sizes");
  const outputDir = path.resolve(valueFor(args, "--output-dir") ?? env.WOTON_BENCH_OUTPUT_DIR ?? "benchmarks/results");
  const tempDir = path.resolve(valueFor(args, "--temp-dir") ?? env.WOTON_BENCH_TEMP_DIR ?? path.join(os.tmpdir(), "woton-benchmarks"));
  const getSamples = positiveInteger(valueFor(args, "--get-samples") ?? env.WOTON_BENCH_GET_SAMPLES, 1_000);

  const envSizes = env.WOTON_BENCH_SIZES;
  const sizes = smoke
    ? [100]
    : parseSizes(sizesFromCli ?? envSizes ?? (includeOneMillion ? "10000,100000,1000000" : "10000,100000"));

  if (sizes.some((size) => size >= 1_000_000) && !includeOneMillion) {
    throw new Error("1M scenarios require --include-1m or WOTON_BENCH_INCLUDE_1M=1.");
  }

  return {
    includeOneMillion,
    keepFiles,
    outputDir,
    tempDir,
    sizes,
    getSamples
  };
}

function valueFor(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }

  return undefined;
}

function parseSizes(input: string): number[] {
  const sizes = input
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);

  if (sizes.length === 0) {
    throw new Error("No valid benchmark sizes were provided.");
  }

  return [...new Set(sizes)];
}

function positiveInteger(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const value = Number.parseInt(input, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function assertDistExists(): void {
  if (!existsSync(path.resolve("dist/index.js"))) {
    throw new Error("dist/index.js was not found. Run npm run build before running benchmarks.");
  }
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();

  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal
  };
}

function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
}

function printScenario(result: ScenarioResult): void {
  const rows = [
    ["insert autosave:false", `${formatMs(result.measurements.insertBatchAutosaveFalse.ms)} (${formatRate(result.records, result.measurements.insertBatchAutosaveFalse.ms)}/s)`],
    ["flush", formatMs(result.measurements.flush.ms)],
    ["reopen", formatMs(result.measurements.reopen.ms)],
    ["get by id", `${formatMs(result.measurements.getById.ms)} (${result.measurements.getById.found}/${result.measurements.getById.operations})`],
    ["query no index", `${formatMs(result.measurements.queryNoIndex.ms)} (${formatNumber(result.measurements.queryNoIndex.matched)} rows)`],
    ["create index", formatMs(result.measurements.createIndex.ms)],
    ["query with index", `${formatMs(result.measurements.queryWithIndex.ms)} (${formatNumber(result.measurements.queryWithIndex.matched)} rows)`],
    ["count", `${formatMs(result.measurements.count.ms)} (${formatNumber(result.measurements.count.counted)})`],
    ["file size", formatBytes(result.fileSizeBytes)],
    ["rss / heap", `${formatBytes(result.memoryFinal.rssBytes)} / ${formatBytes(result.memoryFinal.heapUsedBytes)}`]
  ];

  if (result.checkpointProfile) {
    rows.splice(2, 0, ["serialize", formatMs(result.checkpointProfile.serializeMs)]);
    rows.splice(3, 0, ["encrypt", formatMs(result.checkpointProfile.encryptMs)]);
    rows.splice(4, 0, ["write", formatMs(result.checkpointProfile.writeMs)]);
    rows.splice(5, 0, ["fsync", formatMs(result.checkpointProfile.fsyncMs)]);
    rows.splice(6, 0, ["rename", formatMs(result.checkpointProfile.renameMs)]);
    rows.splice(7, 0, ["dir fsync", formatMs(result.checkpointProfile.directoryFsyncMs)]);
  }

  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(22)} ${value}`);
  }
  console.log("");
}

function printCheckpointProfile(profile: WotonCheckpointProfile): void {
  console.log(
    `  ${"checkpoint detail".padEnd(22)} serialize ${formatMs(profile.serializeMs)} | ` +
      `encrypt ${formatMs(profile.encryptMs)} | write ${formatMs(profile.writeMs)} | ` +
      `fsync ${formatMs(profile.fsyncMs)} | rename ${formatMs(profile.renameMs)} | ` +
      `dir ${formatMs(profile.directoryFsyncMs)}`
  );
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

function formatRate(count: number, ms: number): string {
  if (ms <= 0) {
    return "n/a";
  }

  return formatNumber(Math.round(count / (ms / 1_000)));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

async function cleanup(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}.lock`, { force: true });
  await rm(`${databasePath}-lock`, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
