import { parentPort } from "node:worker_threads";
import { scanPagedRecordEquality } from "./paged-record-store.js";
import type { PagedEqualityScanOptions } from "./paged-record-store.js";
import type { WcwWorkerFailure, WcwWorkerRequest, WcwWorkerResult } from "./wcw.js";

if (!parentPort) {
  throw new Error("WCW worker must run inside a worker thread.");
}

parentPort.on("message", (message: WcwWorkerRequest) => {
  void handleMessage(message);
});

async function handleMessage(message: WcwWorkerRequest): Promise<void> {
  if (message.type !== "scan-equality") {
    return;
  }

  try {
    const result = await scanPagedRecordEquality(normalizeDatabaseOptions(message.database), message.query);
    parentPort!.postMessage({
      type: "scan-result",
      id: message.id,
      result
    } satisfies WcwWorkerResult);
  } catch (error) {
    parentPort!.postMessage({
      type: "scan-error",
      id: message.id,
      message: error instanceof Error ? error.message : "Unknown WCW worker error."
    } satisfies WcwWorkerFailure);
  }
}

function normalizeDatabaseOptions(options: PagedEqualityScanOptions): PagedEqualityScanOptions {
  if (options.encryptionPassword && typeof options.encryptionPassword !== "string") {
    return {
      ...options,
      encryptionPassword: Buffer.from(options.encryptionPassword)
    };
  }

  return options;
}
