import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { DbConnection } from "./connection.js";
import {
  listThreadsWithPendingInteractionState,
  listThreadsWithPendingInteractionStateForProjects,
  type ListThreadsForProjectsOptions,
  type ListThreadsOptions,
  type ThreadWithPendingInteractionState,
} from "./data/threads.js";
import type {
  SqliteReadRequest,
  SqliteReadResponse,
} from "./sqlite-read-worker.js";

type PendingRead = {
  reject: (error: Error) => void;
  resolve: (result: ThreadWithPendingInteractionState[]) => void;
};

let worker: Worker | null = null;
const pending = new Map<number, PendingRead>();
let nextRequestId = 1;

function workerFilename(): string {
  const tsFilename = fileURLToPath(
    new URL("./sqlite-read-worker.ts", import.meta.url),
  );
  if (existsSync(tsFilename)) {
    return tsFilename;
  }
  const jsFilename = fileURLToPath(
    new URL("./sqlite-read-worker.js", import.meta.url),
  );
  if (existsSync(jsFilename)) {
    return jsFilename;
  }
  throw new Error("sqlite read worker file is missing");
}

function failAll(error: Error): void {
  for (const request of pending.values()) {
    request.reject(error);
  }
  pending.clear();
}

export function isSqliteReadWorkerActive(): boolean {
  return worker !== null;
}

export function startSqliteReadWorker(args: {
  source: string | Buffer;
  workerFilename?: string;
}): void {
  if (worker !== null) {
    return;
  }
  if (typeof args.source !== "string" || args.source === ":memory:") {
    return;
  }
  const filename = args.workerFilename ?? workerFilename();
  const next = new Worker(filename, {
    execArgv: filename.endsWith(".ts")
      ? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
      : [],
    workerData: { source: args.source },
  });
  next.on("message", (response: SqliteReadResponse) => {
    const request = pending.get(response.id);
    if (request === undefined) {
      return;
    }
    pending.delete(response.id);
    if (response.ok) {
      request.resolve(response.result as ThreadWithPendingInteractionState[]);
      return;
    }
    request.reject(new Error(response.error));
  });
  next.on("error", (error) => {
    failAll(error);
    worker = null;
  });
  next.on("exit", (code) => {
    if (pending.size > 0) {
      failAll(new Error(`sqlite read worker exited with code ${code}`));
    }
    worker = null;
  });
  worker = next;
}

export async function stopSqliteReadWorker(): Promise<void> {
  const current = worker;
  worker = null;
  failAll(new Error("sqlite read worker closed"));
  if (current === null) {
    return;
  }
  await current.terminate();
}

async function request(
  message: Omit<SqliteReadRequest, "id">,
): Promise<ThreadWithPendingInteractionState[]> {
  const current = worker;
  if (current === null) {
    throw new Error("sqlite read worker is not running");
  }
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
    current.postMessage({ id, ...message } as SqliteReadRequest);
  });
}

export async function listThreadsWithPendingInteractionStateOffThread(
  db: DbConnection,
  options: ListThreadsOptions,
): Promise<ThreadWithPendingInteractionState[]> {
  if (worker === null) {
    return listThreadsWithPendingInteractionState(db, options);
  }
  return request({
    name: "listThreadsWithPendingInteractionState",
    args: options,
  });
}

export async function listThreadsWithPendingInteractionStateForProjectsOffThread(
  db: DbConnection,
  options: ListThreadsForProjectsOptions,
): Promise<ThreadWithPendingInteractionState[]> {
  if (worker === null) {
    return listThreadsWithPendingInteractionStateForProjects(db, options);
  }
  return request({
    name: "listThreadsWithPendingInteractionStateForProjects",
    args: options,
  });
}
