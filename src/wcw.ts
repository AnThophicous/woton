import { Worker } from "node:worker_threads";
import { BinaryCache, equalityQueryHash } from "./binary-cache.js";
import type {
  PagedEqualityScanOptions,
  PagedEqualityScanQuery,
  PagedEqualityScanResult,
  PagedRecordPointer
} from "./paged-record-store.js";

export interface WcwOptions {
  readonly database: PagedEqualityScanOptions;
  readonly cache: BinaryCache;
  readonly recordCount: () => number;
  readonly onPointer: (query: PagedEqualityScanQuery, pointer: PagedRecordPointer) => Promise<boolean>;
  readonly minHits?: number;
  readonly minRecords?: number;
  readonly maxTrackedQueries?: number;
  readonly maxPendingTasks?: number;
  readonly maxConcurrentTasks?: number;
}

export interface WcwStats {
  readonly trackedQueries: number;
  readonly pendingTasks: number;
  readonly activeTasks: number;
  readonly cacheEntries: number;
  readonly maxCacheEntries: number;
  readonly admittedQueries: number;
  readonly completedTasks: number;
  readonly cachedPointers: number;
  readonly skippedSmallStores: number;
  readonly droppedTasks: number;
  readonly disabled: boolean;
}

export interface WcwWorkerRequest {
  readonly type: "scan-equality";
  readonly id: number;
  readonly database: PagedEqualityScanOptions;
  readonly query: PagedEqualityScanQuery;
}

export interface WcwWorkerResult {
  readonly type: "scan-result";
  readonly id: number;
  readonly result: PagedEqualityScanResult;
}

export interface WcwWorkerFailure {
  readonly type: "scan-error";
  readonly id: number;
  readonly message: string;
}

type WcwWorkerMessage = WcwWorkerResult | WcwWorkerFailure;

interface TrackedQuery {
  readonly hash: number;
  readonly query: PagedEqualityScanQuery;
  hits: number;
  queued: boolean;
}

interface QueuedTask {
  readonly id: number;
  readonly hash: number;
  readonly query: PagedEqualityScanQuery;
}

const DEFAULT_MIN_HITS = 3;
const DEFAULT_MIN_RECORDS = 4096;
const DEFAULT_MAX_TRACKED_QUERIES = 128;
const DEFAULT_MAX_PENDING_TASKS = 16;
const DEFAULT_MAX_CONCURRENT_TASKS = 1;

export class WotonConnectedWorker {
  private readonly tracked = new Map<number, TrackedQuery>();
  private readonly queue: QueuedTask[] = [];
  private readonly inflight = new Map<number, QueuedTask>();
  private readonly idleResolvers: Array<() => void> = [];
  private worker: Worker | undefined;
  private nextTaskId = 1;
  private closed = false;
  private disabled = false;
  private admittedQueries = 0;
  private completedTasks = 0;
  private cachedPointers = 0;
  private skippedSmallStores = 0;
  private droppedTasks = 0;
  private readonly minHits: number;
  private readonly minRecords: number;
  private readonly maxTrackedQueries: number;
  private readonly maxPendingTasks: number;
  private readonly maxConcurrentTasks: number;

  constructor(private readonly options: WcwOptions) {
    this.minHits = positiveInteger(options.minHits ?? DEFAULT_MIN_HITS);
    this.minRecords = Math.max(0, Math.floor(options.minRecords ?? DEFAULT_MIN_RECORDS));
    this.maxTrackedQueries = positiveInteger(options.maxTrackedQueries ?? DEFAULT_MAX_TRACKED_QUERIES);
    this.maxPendingTasks = positiveInteger(options.maxPendingTasks ?? DEFAULT_MAX_PENDING_TASKS);
    this.maxConcurrentTasks = positiveInteger(options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS);
  }

  recordEquality(query: PagedEqualityScanQuery): void {
    if (this.closed || this.disabled || this.options.cache.get(equalityQueryHash(query.collection, query.field, query.value))) {
      return;
    }

    const hash = equalityQueryHash(query.collection, query.field, query.value);
    const tracked = this.track(hash, query);
    tracked.hits += 1;

    if (tracked.hits < this.minHits || tracked.queued) {
      return;
    }

    if (this.options.recordCount() < this.minRecords) {
      this.skippedSmallStores += 1;
      return;
    }

    this.enqueue(tracked);
  }

  stats(): WcwStats {
    return {
      trackedQueries: this.tracked.size,
      pendingTasks: this.queue.length,
      activeTasks: this.inflight.size,
      cacheEntries: this.options.cache.size,
      maxCacheEntries: this.options.cache.maxEntryCount,
      admittedQueries: this.admittedQueries,
      completedTasks: this.completedTasks,
      cachedPointers: this.cachedPointers,
      skippedSmallStores: this.skippedSmallStores,
      droppedTasks: this.droppedTasks,
      disabled: this.disabled
    };
  }

  async idle(): Promise<void> {
    if (this.queue.length === 0 && this.inflight.size === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.queue.length = 0;
    this.inflight.clear();
    this.resolveIdle();

    if (this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      await worker.terminate().catch(() => undefined);
    }
  }

  private track(hash: number, query: PagedEqualityScanQuery): TrackedQuery {
    const existing = this.tracked.get(hash);

    if (existing) {
      this.tracked.delete(hash);
      this.tracked.set(hash, existing);
      return existing;
    }

    while (this.tracked.size >= this.maxTrackedQueries) {
      const oldest = this.tracked.keys().next().value as number | undefined;

      if (oldest === undefined) {
        break;
      }

      this.tracked.delete(oldest);
    }

    const tracked: TrackedQuery = {
      hash,
      query,
      hits: 0,
      queued: false
    };
    this.tracked.set(hash, tracked);
    return tracked;
  }

  private enqueue(tracked: TrackedQuery): void {
    if (this.queue.length + this.inflight.size >= this.maxPendingTasks) {
      this.droppedTasks += 1;
      return;
    }

    tracked.queued = true;
    this.queue.push({
      id: this.nextTaskId++,
      hash: tracked.hash,
      query: tracked.query
    });
    this.admittedQueries += 1;
    this.drain();
  }

  private drain(): void {
    if (this.closed || this.disabled) {
      this.resolveIdle();
      return;
    }

    while (this.queue.length > 0 && this.inflight.size < this.maxConcurrentTasks) {
      const task = this.queue.shift()!;
      const worker = this.ensureWorker();

      if (!worker) {
        this.droppedTasks += 1;
        continue;
      }

      this.inflight.set(task.id, task);
      worker.postMessage({
        type: "scan-equality",
        id: task.id,
        database: this.options.database,
        query: task.query
      } satisfies WcwWorkerRequest);
    }

    this.resolveIdle();
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) {
      return this.worker;
    }

    try {
      const worker = new Worker(new URL("./wcw-worker.js", import.meta.url));
      worker.on("message", (message: WcwWorkerMessage) => {
        void this.handleWorkerMessage(message);
      });
      worker.on("error", () => {
        this.disable();
      });
      worker.on("exit", (code) => {
        if (!this.closed && code !== 0) {
          this.disable();
        }
      });
      this.worker = worker;
      return worker;
    } catch {
      this.disable();
      return undefined;
    }
  }

  private async handleWorkerMessage(message: WcwWorkerMessage): Promise<void> {
    const task = this.inflight.get(message.id);

    if (!task) {
      return;
    }

    this.inflight.delete(message.id);
    this.tracked.delete(task.hash);

    if (message.type === "scan-result") {
      this.completedTasks += 1;

      if (message.result.pointer && await this.options.onPointer(task.query, message.result.pointer)) {
        this.cachedPointers += 1;
      }
    } else {
      this.droppedTasks += 1;
    }

    this.drain();
  }

  private disable(): void {
    this.disabled = true;
    this.queue.length = 0;
    this.inflight.clear();
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.queue.length > 0 || this.inflight.size > 0) {
      return;
    }

    const resolvers = this.idleResolvers.splice(0);

    for (const resolve of resolvers) {
      resolve();
    }
  }
}

function positiveInteger(value: number): number {
  return Math.max(1, Math.floor(value));
}
