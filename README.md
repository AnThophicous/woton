# Woton

<p align="center">
  <img src="https://raw.githubusercontent.com/AnThophicous/woton/main/Images/Banner.png" alt="Woton banner" width="900">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/AnThophicous/woton/main/Images/Woton.png" alt="Woton logo" width="180">
</p>

Woton is an encrypted embedded database for Node.js, written in TypeScript and exposed through a JavaScript-first API. It stores local JSON documents in a single `.wtdb` database file, with a small query builder, a compact text language for CLI and scripts, transactions, WAL recovery, and an experimental paged-storage layer for future lower-level engines.

> Status: `0.2.0`, alpha-stage. Woton is usable for local experimentation, prototypes, tests, CLIs, and small embedded data stores. It is not marketed as production-ready security software. Do not treat it as audited, hardened, or suitable for high-risk secrets until the project has had external security review, larger benchmarks, fuzzing, and operational hardening.

Links:

- GitHub repository: <https://github.com/AnThophicous/woton>
- NPM package: <https://www.npmjs.com/package/woton>

## Table of Contents

- [Install](#install)
- [Create Your First Database](#create-your-first-database)
- [Opening Databases](#opening-databases)
- [Data Model](#data-model)
- [Collections and CRUD](#collections-and-crud)
- [TypeScript](#typescript)
- [Query Builder](#query-builder)
- [Indexes](#indexes)
- [Woton Language API](#woton-language-api)
- [CLI](#cli)
- [Transactions](#transactions)
- [Persistence, Flush, and Checkpoints](#persistence-flush-and-checkpoints)
- [Backups](#backups)
- [Stats](#stats)
- [Password Rotation](#password-rotation)
- [Security Model and Limits](#security-model-and-limits)
- [WAL, Recovery, and Lock Files](#wal-recovery-and-lock-files)
- [Performance Notes](#performance-notes)
- [Lown Multi-Database Scheduler](#lown-multi-database-scheduler)
- [Advanced and Experimental Internals](#advanced-and-experimental-internals)
- [Tests and Benchmarks](#tests-and-benchmarks)
- [Publishing and Repository Hygiene](#publishing-and-repository-hygiene)
- [Common Errors](#common-errors)
- [License](#license)

## Install

Woton requires Node.js `20+` and is ESM-only.

```bash
npm install woton
```

For local development from this repository:

```bash
npm install
npm test
npm run build
```

## Create Your First Database

Create a database file with a high-entropy password or passphrase. The default minimum password length is 16 bytes, not 16 characters. Non-ASCII strings can use more than one byte per character, but length is not the same thing as entropy. Prefer a secret manager, an environment variable populated by your deployment system, or a long generated passphrase.

```ts
import { Woton } from "woton";

const password = process.env.WOTON_PASSWORD;

if (!password) {
  throw new Error("Set WOTON_PASSWORD first.");
}

const db = await Woton.open({
  path: "./data/app.wtdb",
  password
});

const users = db.collection("users");

await users.index("email");

await users.insert({
  id: "ada",
  name: "Ada Lovelace",
  email: "ada@example.com",
  active: true,
  age: 36
});

const ada = await users.where("email", "ada@example.com").first();

console.log(ada);

await db.close();
```

The first open creates `./data/app.wtdb`. During normal use Woton may also create `./data/app.wtdb-wal` and `./data/app.wtdb-lock`.

## Opening Databases

```ts
const db = await Woton.open({
  path: "./data/app.wtdb",
  password,
  autosave: true,
  minPasswordLength: 16,
  checkpointEveryWrites: 1000,
  forceUnlock: false
});
```

`Woton.open` options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | required | Database path. It must end in `.wtdb`. |
| `password` | `string \| Buffer` | required | Password material used for encryption key derivation. |
| `autosave` | `boolean` | `true` | When true, writes are appended to the encrypted WAL and later checkpointed. |
| `minPasswordLength` | `number` | `16` | Minimum password size in bytes. |
| `checkpointEveryWrites` | `number` | `1000` | Number of pending WAL operations before Woton writes a fresh encrypted checkpoint. |
| `forceUnlock` | `boolean` | `false` | Dangerous last-resort lock removal. Use only after verifying no process is using the database. |

Always call `await db.close()` when done. `close()` flushes pending data and releases the lock file.

## Data Model

Woton stores documents in named collections:

```text
database
  users
    ada
    grace
  posts
    post-1
```

Each record is a JSON-safe object plus metadata:

```ts
type WotonRecord<T extends object> = T & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
```

Accepted values:

- `string`
- finite `number`
- `boolean`
- `null`
- arrays of JSON-safe values
- plain objects with JSON-safe values

Rejected values include `undefined`, functions, symbols, `bigint`, class instances, and `Date` objects. Store dates as strings:

```ts
await events.insert({
  id: "release",
  startsAt: new Date().toISOString()
});
```

Name rules:

- Collections: start with a letter, max 64 characters, then letters, numbers, `_`, `:`, or `-`.
- Record IDs: start with a letter or number, max 128 characters, then letters, numbers, `_`, `.`, `:`, or `-`.
- Field paths: start with a letter or `_`, max 128 characters, then letters, numbers, `_`, `.`, or `-`.

## Collections and CRUD

You can use the collection wrapper:

```ts
const users = db.collection("users");
```

Or call database methods directly:

```ts
await db.insert("users", { id: "ada", name: "Ada" });
```

Create collections explicitly when useful:

```ts
await db.createCollection("users");
const info = await db.collections();
await db.dropCollection("old_users");
```

Insert:

```ts
const created = await users.insert({
  id: "ada",
  name: "Ada",
  email: "ada@example.com"
});
```

Insert with separate ID:

```ts
await users.insert(
  { name: "Grace", email: "grace@example.com" },
  { id: "grace" }
);
```

Insert without an ID to generate a UUID:

```ts
const record = await users.insert({ name: "Lin" });
console.log(record.id);
```

Replace or create with `put`:

```ts
await users.put("ada", {
  name: "Ada Lovelace",
  email: "ada@example.com"
});
```

`put` preserves `createdAt` when replacing an existing record and updates `updatedAt`.

Read:

```ts
const ada = await users.get("ada"); // WotonRecord<User> | null
const all = await users.all();
const total = await users.count();
```

Patch:

```ts
await users.update("ada", {
  active: true
});
```

`update` is a shallow merge. It cannot change `id` or `createdAt`.

Delete:

```ts
const existed = await users.delete("ada");
```

## TypeScript

Woton ships TypeScript declarations from `dist/index.d.ts`.

```ts
import { Woton, type WotonRecord } from "woton";

interface User {
  name: string;
  email: string;
  age: number;
  active: boolean;
  profile?: {
    country: string;
  };
}

const db = await Woton.open({
  path: "./data/app.wtdb",
  password: process.env.WOTON_PASSWORD!
});

const users = db.collection<User>("users");

const created: WotonRecord<User> = await users.insert({
  id: "ada",
  name: "Ada",
  email: "ada@example.com",
  age: 36,
  active: true
});

const activeUsers = await users
  .where("active", true)
  .sort("name", "asc")
  .find();
```

Woton validates JSON safety at runtime. TypeScript helps at compile time, but it does not replace runtime validation.

## Query Builder

The query builder supports equality, comparison, string/array operators, ordering, limits, and offsets.

```ts
const page = await users
  .where("active", true)
  .and("age", ">=", 18)
  .sort("name", "asc")
  .skip(20)
  .take(20)
  .find();
```

`where("field", value)` is shorthand for `where("field", "==", value)`.

Supported operators:

- `=`
- `==`
- `!=`
- `>`
- `>=`
- `<`
- `<=`
- `contains`
- `startsWith`
- `endsWith`
- `in`

Nested fields use dot paths:

```ts
const brUsers = await users
  .where("profile.country", "BR")
  .find();
```

Counting through a query:

```ts
const activeCount = await users
  .where("active", true)
  .count();
```

## Indexes

Indexes are declared per collection and field:

```ts
await users.index("email");
await users.index("profile.country");
```

Remove an index:

```ts
await users.unindex("email");
```

Current indexes accelerate equality queries only: `=` and `==`. Other operators still work, but they scan the candidate records after any applicable equality index is used.

```ts
await users.index("email");

const ada = await users
  .where("email", "==", "ada@example.com")
  .first();
```

Indexes are tracked in the encrypted database state and rebuilt in memory when the database opens.

## Woton Language API

Woton includes a small text language for CLI, scripts, and automation. It is intentionally not SQL and does not use `eval`.

```ts
await db.query("make users");
await db.query('put users { "id": "ada", "name": "Ada", "active": true }');
await db.query("index users email");
await db.query('from users where active == true sort name asc limit 10');
```

Commands:

```text
make users
drop users
index users email
unindex users email
put users { "id": "ada", "name": "Ada" }
get users ada
set users ada { "active": true }
del users ada
delete users ada
from users where age >= 18 sort name asc limit 10
count users where active == true
```

JSON payloads for `put` and `set` must be valid JSON objects. Query values can be quoted strings, numbers, booleans, `null`, arrays, or JSON values where supported by the tokenizer.

## CLI

After installation or build, the `woton` binary opens one `.wtdb` file and runs one Woton language command. The password is read from `WOTON_PASSWORD`; it is not accepted as a CLI argument.

```bash
WOTON_PASSWORD="use a high entropy secret" woton ./data/app.wtdb "from users limit 10"
```

From stdin:

```bash
echo 'count users where active == true' | WOTON_PASSWORD="use a high entropy secret" woton ./data/app.wtdb
```

Local repository build:

```bash
npm run build
node dist/cli.js ./data/app.wtdb "from users limit 10"
```

## Transactions

Transactions group multiple writes into one queued operation. If the handler throws, Woton rolls back in-memory changes before the transaction is committed.

```ts
await db.transaction(async (tx) => {
  const users = tx.collection<User>("users");
  const audit = tx.collection("audit");

  await users.update("ada", { active: false });
  await audit.insert({
    action: "user.deactivated",
    userId: "ada",
    at: new Date().toISOString()
  });
});
```

The transaction API mirrors collection CRUD and query builder methods. Woton serializes writes per database instance through an internal write queue.

## Persistence, Flush, and Checkpoints

With the default `autosave: true`, each write appends encrypted WAL frames to `.wtdb-wal`. Woton writes a fresh encrypted checkpoint to `.wtdb` after `checkpointEveryWrites` pending WAL operations, and also during `flush()` or `close()` when dirty data exists.

```ts
await db.flush();
await db.close();
```

`flush()` waits for queued writes and checkpoints dirty state. Checkpointing uses an atomic temp-file write and rename pattern.

### `autosave: false` Warning

`autosave: false` disables WAL appends for writes. This can be useful for fast bulk loading, but durability is weaker: unflushed writes can be lost if the process exits or crashes before `flush()` or `close()`.

```ts
const db = await Woton.open({
  path: "./data/import.wtdb",
  password,
  autosave: false
});

for (const row of rows) {
  await db.collection("events").insert(row);
}

await db.flush();
await db.close();
```

Use `autosave: false` only when your application can tolerate replaying or losing the current batch.

## Backups

```ts
await db.backup("./backups/app-copy.wtdb");
```

`backup()` flushes first, then copies the encrypted `.wtdb` file. The backup remains encrypted with the current password. Keep backups out of Git and package artifacts.

## Stats

```ts
const stats = await db.stats();
```

Example shape:

```json
{
  "path": "./data/app.wtdb",
  "formatVersion": 2,
  "collections": 2,
  "records": 1200,
  "indexes": 3,
  "fileSizeBytes": 94012,
  "journalSizeBytes": 0,
  "pendingJournalOperations": 0,
  "encrypted": true
}
```

When a checkpoint has run, `lastCheckpoint` may include timing fields such as serialization, encryption, write, fsync, rename, directory fsync, total time, and byte size.

## Password Rotation

```ts
await db.changePassword(newPassword);
```

`changePassword()` validates the new password, creates a new encryption key, checkpoints the current state, and clears pending WAL state. Use a secret manager or high-entropy passphrase. The default minimum is 16 bytes; applications can raise it with `minPasswordLength`.

## Security Model and Limits

Woton currently provides:

- AES-256-GCM encryption for the main `.wtdb` file.
- `scrypt`-based key derivation.
- Random salt and IV values.
- Authenticated encrypted WAL frames.
- File extension checks for `.wtdb`.
- Validation for collection names, record IDs, field paths, and JSON-safe documents.
- A parser that does not execute user code.
- Single-process lock files to reduce accidental concurrent opens.

Important limits:

- Woton is alpha-stage and has not had an external security audit.
- Do not claim or assume production-ready security.
- Woton protects data at rest only when password handling, host security, backups, logs, and memory exposure are also handled by your application.
- A weak password can still be brute-forced offline from a stolen database.
- Woton does not provide access control, users, roles, network authentication, or row-level permissions.
- Woton is not a distributed system and does not provide distributed consensus or distributed locks.
- Lock files are advisory process/file coordination, not a security boundary.

## WAL, Recovery, and Lock Files

Main database files:

- `.wtdb`: encrypted database checkpoint.
- `.wtdb-wal`: encrypted write-ahead log frames for writes since the last checkpoint.
- `.wtdb-lock`: lock file for a currently open database.

On open, Woton reads the encrypted checkpoint, reads committed WAL frames, applies them in sequence, rebuilds indexes as needed, and checkpoints recovered state. Truncated final WAL records are ignored as incomplete. Corruption before the end of the WAL is treated as a file error.

Woton is single-writer per database file. Do not open the same `.wtdb` for writing from multiple processes. The lock file helps catch local accidental concurrent opens, but it is not a distributed lock and should not be used for network filesystem coordination.

Stale lock recovery:

- If the lock belongs to the same host and the recorded process is no longer alive, Woton can remove it.
- If the lock is corrupt, belongs to another host, or looks active, opening fails.
- `forceUnlock: true` deletes the lock as a dangerous last resort. Use it only after verifying no process is using the database file. Misuse can corrupt or lose data.

## Performance Notes

The default high-level Woton engine keeps the working database state and indexes in memory. Writes append compact encrypted WAL frames and periodic checkpoints rewrite the encrypted snapshot.

Good fits today:

- Small to medium embedded datasets.
- Local CLI tools.
- Tests and fixtures.
- Desktop or single-process Node utilities.
- Prototypes that need encrypted local persistence.

Be careful with:

- Very large datasets.
- Many concurrent writers.
- Network filesystems.
- Workloads that need streaming scans, partial loading, or multi-process writes.
- High-risk regulated production secrets.

Index equality fields you query often. Use `autosave: false` only for replayable bulk loads. Run benchmarks with your own data shape before depending on performance claims.

## Lown Multi-Database Scheduler

Lown is Woton's multi-database coordinator. It opens multiple Woton databases and schedules work using database priorities, operation priorities, aging, observed query behavior, and optional semantic scoring.

Use Lown when one Node process needs to coordinate several local Woton database files:

```ts
import { Lown } from "woton";

const lown = await Lown.open({
  databases: {
    auth: {
      path: "./data/auth.wtdb",
      password,
      priority: 9
    },
    logs: {
      path: "./data/logs.wtdb",
      password,
      priority: 2,
      autosave: false
    }
  },
  scheduler: {
    maxConcurrent: 1,
    agingMs: 250,
    maxQueueSize: 1024
  }
});
```

Scheduler defaults:

- `maxConcurrent`: `1`
- `agingMs`: `250`
- `maxQueueSize`: `1024`

Priorities are numbers from `0` to `10`. The default database priority is `5`. Operation-level priority also defaults to `5`. Higher priority work is scheduled first, while aging prevents older queued work from being ignored forever.

### Accessing Databases

```ts
const auth = lown.database("auth");
const alsoAuth = lown.get("auth");
const viaProxy = lown.db.auth;
```

All three return a `LownDatabase`.

### Collections Through Lown

```ts
const sessions = lown.db.auth.collection("sessions");

await sessions.insert({
  id: "session-1",
  userId: "ada",
  expiresAt: new Date(Date.now() + 3600_000).toISOString()
});

const session = await sessions.get("session-1");
```

`LownCollection` supports `insert`, `create`, `put`, `get`, `update`, `delete`, `all`, `count`, `index`, `unindex`, `where`, and `query`.

### Priority Management

```ts
lown.priority("auth", 10);
console.log(lown.priority("auth"));

lown.db.logs.priority(1);
console.log(lown.db.logs.priority());
```

Database names may contain letters, numbers, `_`, `.`, `:`, and `-`, up to 128 characters, and must start with a letter or number.

### Attach and Detach

```ts
await lown.attach("cache", {
  path: "./data/cache.wtdb",
  password,
  priority: 4
});

const removed = await lown.detach("cache");
```

`detach()` closes the underlying Woton database and removes its scheduler/model state.

### Status, Stats, and Idle

```ts
console.log(lown.status());
console.log(lown.schedulerStats());
console.log(lown.rank());

await lown.idle();
await lown.close();
```

`status()` returns ranked database information plus scheduler stats. `schedulerStats()` returns queue, running, completed, failed, and rejected counts. `idle()` resolves when queued and running tasks are finished.

### Explain, Rank, Run, and Schedule

`explain()` lets you inspect how Lown scores a text command or explicit context without running it:

```ts
const decision = lown.explain("auth", {
  kind: "read",
  operation: "get",
  collection: "sessions",
  conditions: [{ field: "id", operator: "==", value: "session-1" }],
  priority: 8,
  tags: ["login"]
});

console.log(decision.score, decision.confidence);
```

`LownQueryContext` contains:

```ts
interface LownQueryContext {
  database: string;
  kind: "read" | "write" | "query" | "admin" | "maintenance";
  operation: string;
  collection?: string;
  conditions?: readonly QueryCondition[];
  count?: boolean;
  text?: string;
  priority?: number;
  tags?: readonly string[];
}
```

Run a named operation:

```ts
await lown.db.auth.run("refresh session", async (db) => {
  return db.collection("sessions").get("session-1");
});
```

Schedule with a full context:

```ts
await lown.db.auth.schedule(
  {
    kind: "write",
    operation: "session.touch",
    collection: "sessions",
    conditions: [{ field: "id", operator: "==", value: "session-1" }],
    priority: 9,
    tags: ["auth", "interactive"]
  },
  async (db) => {
    return db.collection("sessions").update("session-1", {
      touchedAt: new Date().toISOString()
    });
  }
);
```

Operation `priority` is independent from database priority. Use it for request-level urgency, for example an interactive login check versus background log ingestion.

### Lown Language Queries

```ts
await lown.db.auth.query('put users { "id": "ada", "email": "ada@example.com" }');
await lown.db.auth.query('from users where email == "ada@example.com" limit 1');
```

Lown parses language commands into scheduling context before executing them.

### Lown Maintenance Wrappers

`LownDatabase` wraps maintenance and admin operations so they also go through the scheduler:

```ts
await lown.db.auth.transaction(async (tx) => {
  await tx.collection("users").update("ada", { active: true });
});

await lown.db.auth.flush();
await lown.db.auth.backup("./backups/auth.wtdb");
await lown.db.auth.changePassword(newPassword);
const stats = await lown.db.auth.stats();
```

### Queue Full Behavior

If the number of queued tasks reaches `maxQueueSize`, new tasks are rejected with `WotonValidationError: Lown scheduler queue is full.` The scheduler increments its `rejected` count. Callers should catch this and retry, shed work, or apply backpressure.

## Advanced and Experimental Internals

These APIs are exported for experiments and future storage work. They are not the default `Woton.open` storage engine and should be treated as advanced/experimental.

### PageManager

`PageManager` manages fixed-size page files with checksums, an LRU-like clean-page cache, and a page WAL.

```ts
import { PageManager } from "woton";

const pages = await PageManager.open({
  path: "./data/pages.bin",
  pageSize: 4096,
  cachePages: 128
});

const pageId = pages.allocatePage();
pages.writePage(pageId, Buffer.from("hello"));
await pages.flush();
await pages.close();
```

Options include `path`, `pageSize` (`4096`, `8192`, or `16384`), `cachePages`, optional `cipher`, and `readOnly`. Page WAL sidecars use `-pwal`.

### EncryptedPageManager

`EncryptedPageManager` wraps `PageManager` with AES-GCM encrypted pages and a key sidecar:

```ts
import { EncryptedPageManager } from "woton";

const pages = await EncryptedPageManager.open({
  path: "./data/pages.enc",
  password,
  pageSize: 8192
});
```

It uses a `-pkey` sidecar for key metadata and `-pwal` for the page WAL.

### PagedBTree

`PagedBTree` stores string keys mapped to pointer values:

```ts
import { PagedBTree } from "woton";

const tree = await PagedBTree.open({
  path: "./data/users.index",
  pageSize: 4096,
  encryptionPassword: password
});

await tree.set("users\0ada", {
  pageId: 1,
  slot: 0,
  checksum: 123
});

const pointer = await tree.get("users\0ada");
```

When encrypted, it uses `EncryptedPageManager` and therefore the same `-pkey` and `-pwal` sidecars.

### PagedRecordStore

`PagedRecordStore` stores full `WotonRecord` objects in record pages and uses a `PagedBTree` ID index.

```ts
import { PagedRecordStore, type WotonRecord } from "woton";

const store = await PagedRecordStore.open({
  path: "./data/records.store",
  pageSize: 4096,
  encryptionPassword: password,
  binaryCachePath: "./data/records.cache"
});

const record: WotonRecord<{ email: string }> = {
  id: "ada",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  email: "ada@example.com"
};

await store.put("users", record);
const found = await store.get("users", "ada");
```

Important: `PagedRecordStore.put(collection, record)` expects a full `WotonRecord` with `id`, `createdAt`, and `updatedAt`. It does not add those fields for you.

Sidecars:

- `-rid`: record ID B+Tree.
- `-bc`: default binary cache file when enabled.
- `-bkey`: binary cache key metadata when encrypted.
- `-pwal`: page WAL for page-backed files.
- `-pkey`: encrypted page key metadata.

### BinaryCache

`BinaryCache` is pointer-cache infrastructure, not a document cache. It maps normalized equality-query hashes to `{ pageId, slot, checksum }` pointers. Defaults are `maxEntries: 256` and `maxFileBytes: 16KB`.

```ts
import { BinaryCache, equalityQueryHash } from "woton";

const cache = await BinaryCache.open({
  path: "./data/records-bc",
  password,
  maxEntries: 256
});

const queryHash = equalityQueryHash("users", "email", "ada@example.com");

await cache.put({
  queryHash,
  pageId: 1,
  slot: 0,
  checksum: 123
});
```

Encrypted binary caches use a `-bkey` sidecar.

### WCW

WCW means Woton Connected Worker. It observes repeated equality lookups on `PagedRecordStore`, then warms `BinaryCache` asynchronously by scanning in a worker thread.

Defaults:

- `minHits`: `3`
- `minRecords`: `4096`
- `maxTrackedQueries`: `128`
- `maxPendingTasks`: `16`
- `maxConcurrentTasks`: `1`

WCW warms only hot equality queries after `minHits` and skips stores below `minRecords` by default.

```ts
const store = await PagedRecordStore.open({
  path: "./data/records.store",
  encryptionPassword: password,
  wcw: {
    minHits: 3,
    minRecords: 4096
  }
});

await store.findFirstByEquality("users", "email", "ada@example.com");
await store.waitForConnectedWorkers();
console.log(store.connectedWorkerStats());
```

## Tests and Benchmarks

Run the test suite:

```bash
npm test
```

Build:

```bash
npm run build
```

Benchmark smoke test:

```bash
npm run benchmark:smoke
```

Full benchmark command:

```bash
npm run benchmark
```

Package inspection:

```bash
npm pack --dry-run
```

Benchmarks are synthetic. They do not replace testing with your own data shape, disk, OS, and workload.

Latest local smoke benchmark used for the initial GitHub/NPM publish:

- Date: April 26, 2026
- Runtime: Node.js `v24.14.1`
- Platform: Windows `win32/x64`
- Command: `node --expose-gc benchmarks/.build/run.js --sizes=1000,10000 --get-samples=500`

| Records | Insert `autosave:false` | Flush | Reopen | Query no index | Query with index | Count | File size | Final RSS / heap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 67.19 ms, 14,884/s | 38.18 ms | 135.41 ms | 4.32 ms | 0.43 ms | 0.57 ms | 190.29 KB | 52.67 MB / 5.99 MB |
| 10,000 | 493.27 ms, 20,273/s | 164.84 ms | 219.52 ms | 18.99 ms | 0.36 ms | 0.12 ms | 1.86 MB | 70.82 MB / 6.05 MB |

Checkpoint details from that run:

| Records | Serialize | Encrypt | Write | Fsync | Rename |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 29.30 ms | 0.93 ms | 0.48 ms | 3.04 ms | 1.61 ms |
| 10,000 | 115.93 ms | 6.58 ms | 25.74 ms | 7.54 ms | 1.68 ms |

## Publishing and Repository Hygiene

Before publishing:

```bash
npm test
npm run build
npm run benchmark:smoke
npm pack --dry-run
```

For release checks:

```bash
npm run release:check
```

GitHub and NPM hygiene:

- Keep the package ESM-compatible with `main`, `types`, and `exports` pointing at `dist`.
- Verify the npm tarball with `npm pack --dry-run`.
- Keep generated benchmark output out of published artifacts unless intentionally included.
- Keep README, LICENSE, and SECURITY.md accurate before publishing.
- Do not publish or commit secrets.

Recommended `.gitignore` and `.npmignore` exclusions for applications using Woton:

```gitignore
# Woton databases and runtime files
*.wtdb
*.wtdb-wal
*.wtdb-lock
*-pwal
*-pkey
*-rid
*-bc
*-bkey

# Secrets and local environments
.env
.env.*
!.env.example

# Backups, benchmark data, and package tarballs
backups/
benchmarks/results/
*.tgz
```

Do not commit database files, WAL files, lock files, sidecars, environment files, backups, benchmark data, or package tarballs.

## Common Errors

`Woton databases must use the .wtdb extension.`

Use a path ending in `.wtdb`.

`Set WOTON_PASSWORD before opening a database.`

The CLI requires the password in the `WOTON_PASSWORD` environment variable.

`The database is already open or locked`

Another process may have the database open, or a stale `.wtdb-lock` exists. Close the other process first. Use `forceUnlock` only after verifying no process is using the database.

`Could not decrypt`

The password is wrong, the file is corrupt, or the database/key material does not match. Check that you are opening the intended file with the intended password.

`Lown scheduler queue is full.`

Lown rejected work because its queue reached `maxQueueSize`. Apply backpressure, retry later, raise `maxQueueSize`, or reduce submitted work.

`Record is too large for one page.`

The experimental `PagedRecordStore` requires each packed record to fit in one page. Use a larger page size or reduce record size.

`Invalid collection name`, `Invalid record id`, or `Invalid field path`

Use the naming rules documented in [Data Model](#data-model).

## License

MIT.
