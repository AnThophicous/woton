import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Lown, type LownQueryContext } from "../index.js";

interface User {
  phone: string;
  active: boolean;
}

const password = "correct horse battery staple";

test("Lown manages multiple Woton databases with explicit priorities", async () => {
  const authPath = tempFile("lown-auth");
  const logsPath = tempFile("lown-logs");
  const lown = await Lown.open({
    databases: {
      auth: { path: authPath, password, priority: 7 },
      logs: { path: logsPath, password, priority: 1 }
    }
  });

  assert.equal(lown.db.auth.priority(), 7);
  lown.db.auth.priority(10);
  assert.equal(lown.priority("auth"), 10);

  const users = lown.db.auth.collection<User>("users");
  await users.insert({ id: "ana", phone: "+5511999999999", active: true });

  assert.equal((await users.where("phone", "+5511999999999").first())?.id, "ana");
  await lown.db.logs.query("make events");
  assert.equal(lown.rank()[0]?.name, "auth");

  await lown.close();
  await cleanup(authPath, logsPath);
});

test("Lown schedules higher priority database work first when tasks arrive together", async () => {
  const authPath = tempFile("lown-scheduler-auth");
  const logsPath = tempFile("lown-scheduler-logs");
  const lown = await Lown.open({
    databases: {
      auth: { path: authPath, password, priority: 10 },
      logs: { path: logsPath, password, priority: 0 }
    },
    scheduler: {
      maxConcurrent: 1
    }
  });
  const order: string[] = [];

  const low = lown.db.logs.run("analytics background report", () => {
    order.push("low");
    return "low";
  });
  const high = lown.db.auth.run("phone verification otp", () => {
    order.push("high");
    return "high";
  });

  assert.deepEqual(await Promise.all([low, high]), ["low", "high"]);
  assert.deepEqual(order, ["high", "low"]);

  await lown.close();
  await cleanup(authPath, logsPath);
});

test("Lown online model learns hot query patterns and ranks phone verification above logs", async () => {
  const authPath = tempFile("lown-ml-auth");
  const logsPath = tempFile("lown-ml-logs");
  const lown = await Lown.open({
    databases: {
      auth: { path: authPath, password, priority: 5 },
      logs: { path: logsPath, password, priority: 5 }
    }
  });
  const users = lown.db.auth.collection<User>("users");
  const queryContext: Omit<LownQueryContext, "database"> = {
    kind: "query",
    operation: "find",
    collection: "users",
    conditions: [{ field: "phone", operator: "==", value: "+5511888888888" }]
  };
  const logContext: Omit<LownQueryContext, "database"> = {
    kind: "query",
    operation: "find",
    collection: "events",
    conditions: [{ field: "level", operator: "==", value: "debug" }]
  };
  const before = lown.db.auth.explain(queryContext);

  await users.insert({ id: "ana", phone: "+5511888888888", active: true });

  for (let index = 0; index < 8; index += 1) {
    assert.equal((await users.where("phone", "+5511888888888").first())?.id, "ana");
  }

  const after = lown.db.auth.explain(queryContext);
  const logDecision = lown.db.logs.explain(logContext);

  assert.equal(after.hits, 8);
  assert.equal(after.hotness > before.hotness, true);
  assert.equal(after.score >= before.score, true);
  assert.equal(after.score > logDecision.score, true);

  await lown.close();
  await cleanup(authPath, logsPath);
});

test("Lown can attach and detach databases at runtime", async () => {
  const authPath = tempFile("lown-attach-auth");
  const logsPath = tempFile("lown-attach-logs");
  const lown = await Lown.open({
    databases: {
      auth: { path: authPath, password, priority: 8 }
    }
  });

  await lown.attach("logs", { path: logsPath, password, priority: 1 });
  assert.equal(lown.status().databases.length, 2);
  assert.equal(await lown.detach("logs"), true);
  assert.equal(await lown.detach("missing"), false);
  assert.equal(lown.status().databases.length, 1);

  await lown.close();
  await cleanup(authPath, logsPath);
});

test("Lown rejects new tasks when the scheduler queue is full", async () => {
  const authPath = tempFile("lown-queue-auth");
  const lown = await Lown.open({
    databases: {
      auth: { path: authPath, password, priority: 5 }
    },
    scheduler: {
      maxConcurrent: 1,
      maxQueueSize: 1
    }
  });
  const first = lown.db.auth.run("slow maintenance", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "done";
  });

  await assert.rejects(
    () => lown.db.auth.run("overflow", () => "overflow"),
    /queue is full/
  );
  assert.equal((await first), "done");
  assert.equal(lown.schedulerStats().rejected, 1);

  await lown.close();
  await cleanup(authPath);
});

function tempFile(label: string): string {
  return path.join(tmpdir(), `woton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wtdb`);
}

async function cleanup(...filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    await rm(filePath, { force: true });
    await rm(`${filePath}-lock`, { force: true });
    await rm(`${filePath}-wal`, { force: true });
  }
}
