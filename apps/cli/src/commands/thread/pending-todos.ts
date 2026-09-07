import type {
  ThreadTimelinePendingTodos,
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
} from "@bb/domain";
import type { BbSdk } from "@bb/sdk";

interface FetchThreadPendingTodosArgs {
  sdk: Pick<BbSdk, "threads">;
  threadId: string;
}

export async function fetchThreadPendingTodos(
  args: FetchThreadPendingTodosArgs,
): Promise<ThreadTimelinePendingTodos | null> {
  try {
    const response = await args.sdk.threads.timeline({
      threadId: args.threadId,
      summaryOnly: "true",
    });
    return response.pendingTodos;
  } catch {
    return null;
  }
}

const STATUS_BULLET: Record<ThreadTimelinePendingTodoItemStatus, string> = {
  in_progress: "[>]",
  pending: "[ ]",
  completed: "[x]",
};

const STATUS_RANK: Record<ThreadTimelinePendingTodoItemStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

interface TodoCounts {
  completed: number;
  total: number;
}

function countTodos(
  items: readonly ThreadTimelinePendingTodoItem[],
): TodoCounts {
  let completed = 0;
  for (const item of items) {
    if (item.status === "completed") completed += 1;
  }
  return { completed, total: items.length };
}

export function printPendingTodos(
  pendingTodos: ThreadTimelinePendingTodos | null,
): void {
  if (!pendingTodos || pendingTodos.items.length === 0) return;
  const counts = countTodos(pendingTodos.items);

  console.log("");
  const heading =
    counts.completed === 0
      ? `TODOs (${counts.total}):`
      : `TODOs (${counts.completed}/${counts.total} done):`;
  console.log(heading);
  const ordered = [...pendingTodos.items].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
  );
  for (const item of ordered) {
    console.log(`  ${STATUS_BULLET[item.status]} ${item.text}`);
  }
}
