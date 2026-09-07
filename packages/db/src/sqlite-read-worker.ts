import { parentPort, workerData } from "node:worker_threads";
import { createConnection } from "./connection.js";
import {
  listThreadsWithPendingInteractionState,
  listThreadsWithPendingInteractionStateForProjects,
  type ListThreadsForProjectsOptions,
  type ListThreadsOptions,
} from "./data/threads.js";

export type SqliteReadRequest =
  | {
      id: number;
      name: "listThreadsWithPendingInteractionState";
      args: ListThreadsOptions;
    }
  | {
      id: number;
      name: "listThreadsWithPendingInteractionStateForProjects";
      args: ListThreadsForProjectsOptions;
    };

export type SqliteReadResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (port === null) {
  throw new Error("sqlite read worker must run as a worker thread");
}

const source = (workerData as { source: string }).source;
const db = createConnection(source, { readonly: true });

port.on("message", (request: SqliteReadRequest) => {
  try {
    const result =
      request.name === "listThreadsWithPendingInteractionState"
        ? listThreadsWithPendingInteractionState(db, request.args)
        : listThreadsWithPendingInteractionStateForProjects(db, request.args);
    const response: SqliteReadResponse = { id: request.id, ok: true, result };
    port.postMessage(response);
  } catch (error) {
    const response: SqliteReadResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});
