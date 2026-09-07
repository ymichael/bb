import { z } from "zod";
import {
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  type DbNotifier,
  type DbTransaction,
  type OpenBackgroundTaskItemRow,
} from "@bb/db";
import {
  backgroundTaskItemStatus,
  isSettledBackgroundTaskStatus,
  threadEventBackgroundTaskItemSchema,
  threadScope,
} from "@bb/domain";
import type { ThreadEventBackgroundTaskItem } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";

interface SettleDanglingBackgroundTasksArgs {
  hostId: string;
}

type SettleDanglingBackgroundTasksDeps = Pick<AppDeps, "db" | "hub" | "logger">;
type SettleDanglingBackgroundTasksTransactionDeps = {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
};

const storedBackgroundTaskEventDataSchema = z.object({
  item: threadEventBackgroundTaskItemSchema,
});

function parseStoredBackgroundTaskItem(
  row: OpenBackgroundTaskItemRow,
): ThreadEventBackgroundTaskItem | null {
  try {
    const parsed = storedBackgroundTaskEventDataSchema.safeParse(
      JSON.parse(row.data),
    );
    return parsed.success ? parsed.data.item : null;
  } catch {
    return null;
  }
}

export function settleDanglingBackgroundTasks(
  deps: SettleDanglingBackgroundTasksDeps,
  args: SettleDanglingBackgroundTasksArgs,
): void {
  const rows = listOpenBackgroundTaskItemRowsForHost(deps.db, {
    hostId: args.hostId,
  });
  if (rows.length === 0) {
    return;
  }

  const settledThreadIds = new Set<string>();
  deps.db.transaction(
    (tx) => {
      for (const threadId of appendDanglingBackgroundTaskCompletions(
        { db: tx, logger: deps.logger },
        rows,
      )) {
        settledThreadIds.add(threadId);
      }
    },
    { behavior: "immediate" },
  );

  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

export function settleDanglingBackgroundTasksForStoppedThreadInTransaction(
  deps: SettleDanglingBackgroundTasksTransactionDeps,
  args: { threadId: string },
): void {
  const rows = listOpenBackgroundTaskItemRowsForThread(deps.db, args);
  const settledThreadIds = appendDanglingBackgroundTaskCompletions(deps, rows);
  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

function appendDanglingBackgroundTaskCompletions(
  deps: Pick<SettleDanglingBackgroundTasksTransactionDeps, "db" | "logger">,
  rows: readonly OpenBackgroundTaskItemRow[],
): Set<string> {
  const settledThreadIds = new Set<string>();
  for (const row of rows) {
    const item = parseStoredBackgroundTaskItem(row);
    if (!item) {
      deps.logger.warn(
        { itemId: row.itemId, threadId: row.threadId },
        "Skipping dangling background task with unparsable item payload",
      );
      continue;
    }
    const providerThreadId = row.providerThreadId ?? "";
    const taskStatus = isSettledBackgroundTaskStatus(item.taskStatus)
      ? item.taskStatus
      : "stopped";
    appendThreadEventsInTransaction(deps.db, [
      {
        threadId: row.threadId,
        environmentId: row.environmentId,
        providerThreadId,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        data: {
          providerThreadId,
          item: {
            ...item,
            status: backgroundTaskItemStatus(taskStatus),
            taskStatus,
          },
        },
      },
    ]);
    settledThreadIds.add(row.threadId);
  }
  return settledThreadIds;
}
