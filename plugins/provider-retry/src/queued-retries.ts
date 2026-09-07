import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * A queued retry as this plugin's surfaces need it. Structural rather than
 * imported from the server contract: a plugin reads what the SDK returns, and
 * only these three fields decide anything here.
 */
export interface QueuedRetry {
  id: string;
  threadId: string;
  /** When core's due sweep will re-attempt it; null when it is already due. */
  sendAt: number | null;
}

/**
 * Every retry currently queued, newest state from the server.
 *
 * This is the whole of the plugin's "what am I waiting on" state. It used to be
 * a Map rebuilt by replaying each thread's event log; queued rows are the
 * durable record now, so the question is one query and a restart cannot lose
 * the answer.
 *
 * Retries are identified by their payload rather than by a wait holder: a retry
 * this plugin asked for waits on the clock like any other scheduled dispatch,
 * so there is no plugin-owned wait to filter on — and a retry is a retry
 * whoever asked for it, which is exactly what these surfaces act on.
 */
export async function listQueuedRetries(
  bb: BbPluginApi,
  threadId?: string,
): Promise<QueuedRetry[]> {
  const rows = await bb.sdk.threads.queue.list(
    threadId === undefined ? {} : { threadId },
  );
  return rows
    .filter((row) => row.payload.kind === "retry")
    .map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sendAt: row.sendAt,
    }));
}

export async function findQueuedRetry(
  bb: BbPluginApi,
  threadId: string,
): Promise<QueuedRetry | null> {
  const rows = await listQueuedRetries(bb, threadId);
  return rows[0] ?? null;
}
