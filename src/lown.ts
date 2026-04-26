import { performance } from "node:perf_hooks";
import { parseLanguage } from "./language.js";
import { Woton, type WotonTransaction } from "./woton.js";
import { WotonValidationError } from "./errors.js";
import { assertFieldPath, assertPositiveInteger, assertRecordId } from "./validation.js";
import type {
  InsertOptions,
  QueryCondition,
  QueryOperator,
  QuerySpec,
  SortDirection,
  WotonDocument,
  WotonOpenOptions,
  WotonPrimitive,
  WotonRecord,
  WotonStats,
  WotonValue
} from "./types.js";

export type LownOperationKind = "read" | "write" | "query" | "admin" | "maintenance";

export interface LownDatabaseOpenOptions extends WotonOpenOptions {
  readonly priority?: number;
}

export interface LownOpenOptions {
  readonly databases: Record<string, LownDatabaseOpenOptions>;
  readonly scheduler?: LownSchedulerOptions;
  readonly model?: LownModelOptions;
}

export interface LownSchedulerOptions {
  readonly maxConcurrent?: number;
  readonly agingMs?: number;
  readonly maxQueueSize?: number;
}

export interface LownModelOptions {
  readonly learningRate?: number;
  readonly semantic?: boolean;
}

export interface LownQueryContext {
  readonly database: string;
  readonly kind: LownOperationKind;
  readonly operation: string;
  readonly collection?: string;
  readonly conditions?: readonly QueryCondition[];
  readonly count?: boolean;
  readonly text?: string;
  readonly priority?: number;
  readonly tags?: readonly string[];
}

export interface LownDecision {
  readonly database: string;
  readonly signature: string;
  readonly score: number;
  readonly confidence: number;
  readonly predictedImportance: number;
  readonly databasePriority: number;
  readonly operationPriority: number;
  readonly semanticScore: number;
  readonly hotness: number;
  readonly ewmaLatencyMs: number;
  readonly hits: number;
}

export interface LownSchedulerStats {
  readonly queued: number;
  readonly running: number;
  readonly maxConcurrent: number;
  readonly maxQueueSize: number;
  readonly completed: number;
  readonly failed: number;
  readonly rejected: number;
}

export interface LownStatus {
  readonly databases: readonly LownDatabaseRank[];
  readonly scheduler: LownSchedulerStats;
}

export interface LownDatabaseRank {
  readonly name: string;
  readonly priority: number;
  readonly score: number;
  readonly queries: number;
}

interface LownObservation {
  readonly latencyMs: number;
  readonly success: boolean;
  readonly resultCount: number;
}

interface LownQueryStats {
  hits: number;
  failures: number;
  ewmaLatencyMs: number;
  ewmaResultCount: number;
  lastSeen: number;
}

interface ScheduledTask<T> {
  readonly id: number;
  readonly context: LownQueryContext;
  readonly decision: LownDecision;
  readonly enqueuedAt: number;
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEFAULT_DATABASE_PRIORITY = 5;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_AGING_MS = 250;
const DEFAULT_MAX_QUEUE_SIZE = 1024;
const DEFAULT_LEARNING_RATE = 0.05;

export class Lown {
  readonly db: Record<string, LownDatabase>;
  private readonly databases = new Map<string, LownDatabase>();
  private readonly scheduler: LownScheduler;
  private closed = false;

  private constructor(
    private readonly model: LownModel,
    schedulerOptions: LownSchedulerOptions | undefined
  ) {
    this.scheduler = new LownScheduler(model, schedulerOptions);
    this.db = new Proxy(Object.create(null) as Record<string, LownDatabase>, {
      get: (_target, property) => {
        if (typeof property !== "string" || property === "then" || property === "toJSON" || property === "inspect") {
          return undefined;
        }

        return this.database(property);
      }
    });
  }

  static async open(options: LownOpenOptions): Promise<Lown> {
    const model = new LownModel(options.model);
    const lown = new Lown(model, options.scheduler);

    try {
      for (const [name, databaseOptions] of Object.entries(options.databases)) {
        await lown.attach(name, databaseOptions);
      }

      if (lown.databases.size === 0) {
        throw new WotonValidationError("Lown requires at least one database.");
      }

      return lown;
    } catch (error) {
      await lown.close().catch(() => undefined);
      throw error;
    }
  }

  database(name: string): LownDatabase {
    this.assertOpen();
    const database = this.databases.get(name);

    if (!database) {
      throw new WotonValidationError(`Unknown Lown database "${name}".`);
    }

    return database;
  }

  get(name: string): LownDatabase {
    return this.database(name);
  }

  async attach(name: string, options: LownDatabaseOpenOptions): Promise<LownDatabase> {
    this.assertOpen();
    assertDatabaseName(name);

    if (this.databases.has(name)) {
      throw new WotonValidationError(`Lown database "${name}" is already attached.`);
    }

    const priority = normalizePriority(options.priority ?? DEFAULT_DATABASE_PRIORITY);
    const { priority: _priority, ...wotonOptions } = options;
    const db = await Woton.open(wotonOptions);
    const handle = new LownDatabase(this, name, db);
    this.databases.set(name, handle);
    this.model.setDatabasePriority(name, priority);
    return handle;
  }

  async detach(name: string): Promise<boolean> {
    this.assertOpen();
    const database = this.databases.get(name);

    if (!database) {
      return false;
    }

    this.databases.delete(name);
    this.model.deleteDatabase(name);
    await database.close();
    return true;
  }

  priority(name: string): number;
  priority(name: string, value: number): this;
  priority(name: string, value?: number): number | this {
    this.assertOpen();

    if (!this.databases.has(name)) {
      throw new WotonValidationError(`Unknown Lown database "${name}".`);
    }

    if (value === undefined) {
      return this.model.databasePriority(name);
    }

    this.model.setDatabasePriority(name, normalizePriority(value));
    return this;
  }

  explain(database: string, input: string | Omit<LownQueryContext, "database">): LownDecision {
    this.assertOpen();
    this.database(database);
    return this.model.decide(typeof input === "string"
      ? contextFromLanguage(database, input)
      : { ...input, database });
  }

  rank(): LownDatabaseRank[] {
    this.assertOpen();
    return [...this.databases.keys()]
      .map((name) => this.model.databaseRank(name))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  }

  status(): LownStatus {
    return {
      databases: this.rank(),
      scheduler: this.scheduler.stats()
    };
  }

  schedulerStats(): LownSchedulerStats {
    return this.scheduler.stats();
  }

  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.scheduler.idle();
    await Promise.all([...this.databases.values()].map((database) => database.close()));
    this.databases.clear();
  }

  schedule<T>(context: LownQueryContext, run: () => Promise<T> | T): Promise<T> {
    this.assertOpen();
    return this.scheduler.schedule(context, async () => run());
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WotonValidationError("Lown is already closed.");
    }
  }
}

export class LownDatabase {
  constructor(
    private readonly owner: Lown,
    readonly name: string,
    private readonly db: Woton
  ) {}

  priority(): number;
  priority(value: number): this;
  priority(value?: number): number | this {
    return value === undefined ? this.owner.priority(this.name) : (this.owner.priority(this.name, value), this);
  }

  raw(): Woton {
    return this.db;
  }

  collection<T extends object = WotonDocument>(name: string): LownCollection<T> {
    return new LownCollection<T>(this, name);
  }

  query(input: string): Promise<unknown> {
    return this.owner.schedule(contextFromLanguage(this.name, input), () => this.db.query(input));
  }

  executeQuery<T extends object>(collection: string, spec: QuerySpec): Promise<WotonRecord<T>[] | number> {
    return this.owner.schedule({
      database: this.name,
      collection,
      conditions: spec.conditions,
      count: spec.count,
      kind: "query",
      operation: spec.count ? "count" : "find"
    }, () => this.db.executeQuery<T>(collection, spec));
  }

  run<T>(operation: string, handler: (db: Woton) => T | Promise<T>): Promise<T> {
    return this.owner.schedule({
      database: this.name,
      kind: classifyOperation(operation),
      operation
    }, () => handler(this.db));
  }

  schedule<T>(context: Omit<LownQueryContext, "database">, handler: (db: Woton) => T | Promise<T>): Promise<T> {
    return this.owner.schedule({
      ...context,
      database: this.name
    }, () => handler(this.db));
  }

  stats(): Promise<WotonStats> {
    return this.owner.schedule({
      database: this.name,
      kind: "maintenance",
      operation: "stats"
    }, () => this.db.stats());
  }

  flush(): Promise<void> {
    return this.schedule({
      kind: "maintenance",
      operation: "flush"
    }, (db) => db.flush());
  }

  backup(targetPath: string): Promise<void> {
    return this.schedule({
      kind: "maintenance",
      operation: "backup"
    }, (db) => db.backup(targetPath));
  }

  changePassword(password: string | Buffer): Promise<void> {
    return this.schedule({
      kind: "admin",
      operation: "changePassword"
    }, (db) => db.changePassword(password));
  }

  transaction<T>(handler: (tx: WotonTransaction) => T | Promise<T>): Promise<T> {
    return this.schedule({
      kind: "write",
      operation: "transaction"
    }, (db) => db.transaction(handler));
  }

  close(): Promise<void> {
    return this.db.close();
  }

  explain(input: string | Omit<LownQueryContext, "database">): LownDecision {
    return this.owner.explain(this.name, input);
  }
}

export class LownCollection<T extends object = WotonDocument> {
  constructor(
    private readonly database: LownDatabase,
    readonly name: string
  ) {}

  insert(document: T & { id?: string }, options?: InsertOptions): Promise<WotonRecord<T>> {
    return this.database.schedule({
      kind: "write",
      operation: "insert",
      collection: this.name
    }, (db) => db.insert<T>(this.name, document, options));
  }

  create(document: T & { id?: string }, options?: InsertOptions): Promise<WotonRecord<T>> {
    return this.insert(document, options);
  }

  put(id: string, document: T): Promise<WotonRecord<T>> {
    assertRecordId(id);
    return this.database.schedule({
      kind: "write",
      operation: "put",
      collection: this.name,
      conditions: [{ field: "id", operator: "==", value: id }]
    }, (db) => db.put<T>(this.name, id, document));
  }

  get(id: string): Promise<WotonRecord<T> | null> {
    assertRecordId(id);
    return this.database.schedule({
      kind: "read",
      operation: "get",
      collection: this.name,
      conditions: [{ field: "id", operator: "==", value: id }]
    }, (db) => db.get<T>(this.name, id));
  }

  update(id: string, patch: Partial<T> & WotonDocument): Promise<WotonRecord<T>> {
    assertRecordId(id);
    return this.database.schedule({
      kind: "write",
      operation: "update",
      collection: this.name,
      conditions: [{ field: "id", operator: "==", value: id }]
    }, (db) => db.update<T>(this.name, id, patch));
  }

  delete(id: string): Promise<boolean> {
    assertRecordId(id);
    return this.database.schedule({
      kind: "write",
      operation: "delete",
      collection: this.name,
      conditions: [{ field: "id", operator: "==", value: id }]
    }, (db) => db.delete(this.name, id));
  }

  all(): Promise<WotonRecord<T>[]> {
    return this.database.executeQuery<T>(this.name, { conditions: [] }) as Promise<WotonRecord<T>[]>;
  }

  index(field: string): Promise<unknown> {
    assertFieldPath(field);
    return this.database.schedule({
      kind: "admin",
      operation: "index",
      collection: this.name,
      conditions: [{ field, operator: "==", value: true }]
    }, (db) => db.index(this.name, field));
  }

  unindex(field: string): Promise<unknown> {
    assertFieldPath(field);
    return this.database.schedule({
      kind: "admin",
      operation: "unindex",
      collection: this.name,
      conditions: [{ field, operator: "==", value: true }]
    }, (db) => db.unindex(this.name, field));
  }

  where(field: string, operator: QueryOperator, value: WotonValue): LownQueryBuilder<T>;
  where(field: string, value: WotonValue): LownQueryBuilder<T>;
  where(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): LownQueryBuilder<T> {
    const builder = new LownQueryBuilder<T>(this.database, this.name);
    return value === undefined
      ? builder.where(field, "==", operatorOrValue as WotonValue)
      : builder.where(field, operatorOrValue as QueryOperator, value);
  }

  query(): LownQueryBuilder<T> {
    return new LownQueryBuilder<T>(this.database, this.name);
  }

  count(): Promise<number> {
    return this.database.executeQuery(this.name, { conditions: [], count: true }) as Promise<number>;
  }
}

export class LownQueryBuilder<T extends object = WotonDocument> {
  private readonly conditions: QueryCondition[] = [];
  private order: QuerySpec["orderBy"];
  private takeValue: number | undefined;
  private skipValue: number | undefined;

  constructor(
    private readonly database: LownDatabase,
    private readonly collection: string
  ) {}

  where(field: string, operator: QueryOperator, value: WotonValue): this;
  where(field: string, value: WotonValue): this;
  where(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): this {
    assertFieldPath(field);
    const operator = value === undefined ? "==" : (operatorOrValue as QueryOperator);
    const actualValue = value === undefined ? (operatorOrValue as WotonValue) : value;
    this.conditions.push({ field, operator, value: actualValue });
    return this;
  }

  and(field: string, operator: QueryOperator, value: WotonValue): this;
  and(field: string, value: WotonValue): this;
  and(field: string, operatorOrValue: QueryOperator | WotonValue, value?: WotonValue): this {
    return value === undefined
      ? this.where(field, operatorOrValue as WotonValue)
      : this.where(field, operatorOrValue as QueryOperator, value);
  }

  sort(field: string, direction: SortDirection = "asc"): this {
    assertFieldPath(field);
    this.order = { field, direction };
    return this;
  }

  orderBy(field: string, direction: SortDirection = "asc"): this {
    return this.sort(field, direction);
  }

  limit(value: number): this {
    assertPositiveInteger(value, "limit");
    this.takeValue = value;
    return this;
  }

  take(value: number): this {
    return this.limit(value);
  }

  offset(value: number): this {
    assertPositiveInteger(value, "offset");
    this.skipValue = value;
    return this;
  }

  skip(value: number): this {
    return this.offset(value);
  }

  async find(): Promise<WotonRecord<T>[]> {
    return this.database.executeQuery<T>(this.collection, this.spec(false)) as Promise<WotonRecord<T>[]>;
  }

  async first(): Promise<WotonRecord<T> | null> {
    const records = await this.limit(1).find();
    return records[0] ?? null;
  }

  async count(): Promise<number> {
    return this.database.executeQuery(this.collection, this.spec(true)) as Promise<number>;
  }

  private spec(count: boolean): QuerySpec {
    return {
      conditions: [...this.conditions],
      orderBy: this.order,
      limit: this.takeValue,
      offset: this.skipValue,
      count
    };
  }
}

class LownScheduler {
  private readonly queue: Array<ScheduledTask<unknown>> = [];
  private running = 0;
  private nextTaskId = 1;
  private drainScheduled = false;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private readonly idleResolvers: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly agingMs: number;
  private readonly maxQueueSize: number;

  constructor(
    private readonly model: LownModel,
    options: LownSchedulerOptions | undefined
  ) {
    this.maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.agingMs = Math.max(1, Math.floor(options?.agingMs ?? DEFAULT_AGING_MS));
    this.maxQueueSize = Math.max(1, Math.floor(options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE));
  }

  schedule<T>(context: LownQueryContext, run: () => Promise<T>): Promise<T> {
    const decision = this.model.decide(context);

    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.maxQueueSize) {
        this.rejected += 1;
        reject(new WotonValidationError("Lown scheduler queue is full."));
        return;
      }

      this.queue.push({
        id: this.nextTaskId++,
        context,
        decision,
        enqueuedAt: performance.now(),
        run,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.requestDrain();
    });
  }

  stats(): LownSchedulerStats {
    return {
      queued: this.queue.length,
      running: this.running,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected
    };
  }

  async idle(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private requestDrain(): void {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const task = this.takeNext();
      this.running += 1;
      void this.execute(task);
    }
  }

  private takeNext(): ScheduledTask<unknown> {
    const now = performance.now();
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue[index]!;
      const aging = (now - task.enqueuedAt) / this.agingMs;
      const score = task.decision.score + aging;

      if (score > bestScore || (score === bestScore && task.id < this.queue[bestIndex]!.id)) {
        bestIndex = index;
        bestScore = score;
      }
    }

    return this.queue.splice(bestIndex, 1)[0]!;
  }

  private async execute(task: ScheduledTask<unknown>): Promise<void> {
    const started = performance.now();

    try {
      const result = await task.run();
      this.model.observe(task.context, {
        latencyMs: performance.now() - started,
        success: true,
        resultCount: resultCount(result)
      });
      this.completed += 1;
      task.resolve(result);
    } catch (error) {
      this.model.observe(task.context, {
        latencyMs: performance.now() - started,
        success: false,
        resultCount: 0
      });
      this.failed += 1;
      task.reject(error);
    } finally {
      this.running -= 1;
      this.resolveIdle();
      this.drain();
    }
  }

  private resolveIdle(): void {
    if (this.queue.length > 0 || this.running > 0) {
      return;
    }

    const resolvers = this.idleResolvers.splice(0);

    for (const resolve of resolvers) {
      resolve();
    }
  }
}

class LownModel {
  private readonly priorities = new Map<string, number>();
  private readonly stats = new Map<string, LownQueryStats>();
  private readonly weights = [-0.2, 1.5, 0.9, 0.6, 0.4, 0.18, 0.2, -0.08];
  private readonly learningRate: number;
  private readonly semanticEnabled: boolean;

  constructor(options: LownModelOptions | undefined) {
    this.learningRate = Math.max(0, Math.min(1, options?.learningRate ?? DEFAULT_LEARNING_RATE));
    this.semanticEnabled = options?.semantic ?? true;
  }

  setDatabasePriority(database: string, value: number): void {
    this.priorities.set(database, normalizePriority(value));
  }

  deleteDatabase(database: string): void {
    this.priorities.delete(database);

    for (const signature of this.stats.keys()) {
      if (signature.startsWith(`${database}|`)) {
        this.stats.delete(signature);
      }
    }
  }

  databasePriority(database: string): number {
    return this.priorities.get(database) ?? DEFAULT_DATABASE_PRIORITY;
  }

  decide(context: LownQueryContext): LownDecision {
    const signature = querySignature(context);
    const stats = this.stats.get(signature);
    const features = this.features(context, stats);
    const predictedImportance = sigmoid(dot(this.weights, features));
    const databasePriority = this.databasePriority(context.database);
    const operationPriority = normalizePriority(context.priority ?? DEFAULT_DATABASE_PRIORITY);
    const semanticScore = features[3]!;
    const hotness = features[4]!;
    const hits = stats?.hits ?? 0;

    return {
      database: context.database,
      signature,
      score: Math.round(predictedImportance * 10_000),
      confidence: Math.min(1, 0.2 + hits / 12 + databasePriority / 40),
      predictedImportance,
      databasePriority,
      operationPriority,
      semanticScore,
      hotness,
      ewmaLatencyMs: stats?.ewmaLatencyMs ?? 0,
      hits
    };
  }

  observe(context: LownQueryContext, observation: LownObservation): void {
    const signature = querySignature(context);
    const stats = this.stats.get(signature) ?? {
      hits: 0,
      failures: 0,
      ewmaLatencyMs: 0,
      ewmaResultCount: 0,
      lastSeen: 0
    };
    const previousFeatures = this.features(context, stats);
    const prediction = sigmoid(dot(this.weights, previousFeatures));

    stats.hits += 1;
    stats.failures += observation.success ? 0 : 1;
    stats.ewmaLatencyMs = ewma(stats.ewmaLatencyMs, observation.latencyMs, stats.hits === 1 ? 1 : 0.25);
    stats.ewmaResultCount = ewma(stats.ewmaResultCount, observation.resultCount, stats.hits === 1 ? 1 : 0.25);
    stats.lastSeen = Date.now();
    this.stats.set(signature, stats);

    const target = this.targetImportance(context, stats, observation);
    const error = target - prediction;

    for (let index = 0; index < this.weights.length; index += 1) {
      this.weights[index] += this.learningRate * error * previousFeatures[index]!;
    }
  }

  databaseRank(name: string): LownDatabaseRank {
    let queries = 0;
    let score = 0;

    for (const [signature, stats] of this.stats.entries()) {
      if (signature.startsWith(`${name}|`)) {
        queries += stats.hits;
        score += Math.min(1, Math.log1p(stats.hits) / Math.log(32));
      }
    }

    return {
      name,
      priority: this.databasePriority(name),
      score: this.databasePriority(name) * 100 + Math.round(score * 10),
      queries
    };
  }

  private features(context: LownQueryContext, stats: LownQueryStats | undefined): number[] {
    const priority = this.databasePriority(context.database) / 10;
    const operationPriority = normalizePriority(context.priority ?? DEFAULT_DATABASE_PRIORITY) / 10;
    const semantic = this.semanticEnabled ? semanticScore(context) : 0.5;
    const hotness = stats ? Math.min(1, Math.log1p(stats.hits) / Math.log(64)) : 0;
    const latency = stats ? Math.min(1, stats.ewmaLatencyMs / 250) : 0;
    const write = context.kind === "write" || context.kind === "admin" ? 1 : 0;
    const broadQuery = context.count || (context.conditions?.length ?? 0) === 0 ? 1 : 0;
    return [1, priority, operationPriority, semantic, hotness, latency, write, broadQuery];
  }

  private targetImportance(context: LownQueryContext, stats: LownQueryStats, observation: LownObservation): number {
    const priority = this.databasePriority(context.database) / 10;
    const operationPriority = normalizePriority(context.priority ?? DEFAULT_DATABASE_PRIORITY) / 10;
    const semantic = this.semanticEnabled ? semanticScore(context) : 0.5;
    const hotness = Math.min(1, Math.log1p(stats.hits) / Math.log(64));
    const latencyPressure = Math.min(1, observation.latencyMs / 250);
    const success = observation.success ? 0.04 : -0.15;
    const pointLookup = observation.resultCount <= 1 && (context.conditions?.length ?? 0) > 0 ? 0.06 : 0;

    return clamp01(
      0.55 * priority +
      0.15 * operationPriority +
      0.20 * semantic +
      0.10 * hotness +
      0.05 * latencyPressure +
      success +
      pointLookup
    );
  }
}

function contextFromLanguage(database: string, input: string): LownQueryContext {
  try {
    const command = parseLanguage(input);

    switch (command.type) {
      case "make":
      case "drop":
        return { database, kind: "admin", operation: command.type, collection: command.collection, text: input };
      case "index":
      case "unindex":
        return {
          database,
          kind: "admin",
          operation: command.type,
          collection: command.collection,
          conditions: [{ field: command.field, operator: "==", value: true }],
          text: input
        };
      case "put":
      case "set":
      case "del":
        return { database, kind: "write", operation: command.type, collection: command.collection, text: input };
      case "get":
        return {
          database,
          kind: "read",
          operation: "get",
          collection: command.collection,
          conditions: [{ field: "id", operator: "==", value: command.id }],
          text: input
        };
      case "from":
      case "count":
        return {
          database,
          kind: "query",
          operation: command.type,
          collection: command.collection,
          conditions: command.spec.conditions,
          count: command.type === "count",
          text: input
        };
    }
  } catch {
    return {
      database,
      kind: "query",
      operation: "language",
      text: input
    };
  }
}

function classifyOperation(operation: string): LownOperationKind {
  const value = operation.toLowerCase();

  if (/(insert|put|update|delete|del|write|save|commit|index|drop|make)/.test(value)) {
    return /(index|drop|make)/.test(value) ? "admin" : "write";
  }

  if (/(flush|stats|backup|close|vacuum|checkpoint)/.test(value)) {
    return "maintenance";
  }

  if (/(query|find|count|scan|where)/.test(value)) {
    return "query";
  }

  return "read";
}

function querySignature(context: LownQueryContext): string {
  const conditionSignature = (context.conditions ?? [])
    .map((condition) => `${condition.field}${condition.operator}`)
    .sort()
    .join("&");
  return [
    context.database,
    context.kind,
    context.operation.toLowerCase(),
    context.collection ?? "",
    conditionSignature,
    context.count ? "count" : "rows"
  ].join("|");
}

function semanticScore(context: LownQueryContext): number {
  const text = [
    context.database,
    context.operation,
    context.collection,
    context.text,
    ...(context.conditions ?? []).map((condition) => condition.field)
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(phone|telefone|otp|2fa|mfa|sms|verify|verification|verificar)/.test(text)) {
    return 0.96;
  }

  if (/(auth|session|sessao|login|token|oauth|password|senha|refresh)/.test(text)) {
    return 0.78;
  }

  if (/(payment|billing|invoice|order|checkout|pagamento|pedido)/.test(text)) {
    return 0.72;
  }

  if (/(user|profile|account|email|usuario|conta)/.test(text)) {
    return 0.56;
  }

  if (/(log|analytics|metric|report|audit|history|evento|evento)/.test(text)) {
    return 0.24;
  }

  return 0.45;
}

function resultCount(result: unknown): number {
  if (Array.isArray(result)) {
    return result.length;
  }

  if (typeof result === "number") {
    return result;
  }

  return result === null || result === undefined || result === false ? 0 : 1;
}

function normalizePriority(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new WotonValidationError("Lown priority must be a number from 0 to 10.");
  }

  return Math.round(value * 100) / 100;
}

function assertDatabaseName(name: string): void {
  if (!DATABASE_NAME.test(name)) {
    throw new WotonValidationError(`Invalid Lown database name "${name}".`);
  }
}

function dot(left: readonly number[], right: readonly number[]): number {
  let value = 0;

  for (let index = 0; index < left.length; index += 1) {
    value += left[index]! * right[index]!;
  }

  return value;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function ewma(current: number, next: number, alpha: number): number {
  return current === 0 ? next : current * (1 - alpha) + next * alpha;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
