import {
  archiveThread,
  listUnarchivedAssignedChildThreads,
  type DbNotifier,
  type DbTransaction,
  updateThread,
} from "@bb/db";
import type { PromptInput, SystemMessageSubject, Thread } from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import {
  buildParentSystemInputFromTemplateSlot,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
} from "./parent-system-messages.js";
import { systemMessageKindForTemplate } from "./system-message-kind.js";
import {
  appendThreadOwnershipChangeEvent,
  appendThreadOwnershipChangeEventInTransaction,
} from "./thread-events.js";

interface ThreadLabelSource {
  id: string;
  projectId: string;
  title: string | null;
}

type ThreadOwnershipTemplateId =
  | "systemMessageThreadOwnershipAssigned"
  | "systemMessageThreadOwnershipRemoved";

interface QueueParentSystemMessageBestEffortArgs {
  childThreadId: string;
  input: PromptInput[];
  parentThreadId: string;
  reason: "assigned" | "removed";
  templateId: ThreadOwnershipTemplateId;
  threadName: string;
}

interface HandleThreadOwnershipChangeArgs {
  previousThread: Thread;
  updatedThread: Thread;
}

interface ReleaseUnarchivedChildrenFromArchivedThreadArgs {
  parentThreadId: string;
}

interface ArchiveThreadAndReleaseChildrenArgs {
  threadId: string;
}

interface ThreadOwnershipTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

const THREAD_OWNERSHIP_MENTION_SLOT = "__BB_THREAD_OWNERSHIP_MENTION__";

async function queueParentSystemMessageBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageBestEffortArgs,
): Promise<void> {
  try {
    const subject: SystemMessageSubject = {
      kind: "thread",
      threadId: args.childThreadId,
      threadName: args.threadName,
    };
    await queueParentSystemMessage(deps, {
      input: args.input,
      parentThreadId: args.parentThreadId,
      systemMessageKind: systemMessageKindForTemplate(args.templateId),
      systemMessageSubject: subject,
    });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThreadId,
        parentThreadId: args.parentThreadId,
        reason: args.reason,
        err: error,
      },
      "Failed to queue parent ownership system message",
    );
  }
}

function buildThreadOwnershipSystemInput(
  templateId: ThreadOwnershipTemplateId,
  thread: ThreadLabelSource,
): PromptInput[] {
  const mention = buildParentSystemThreadMention({ thread });
  const renderedText = renderTemplate(templateId, {
    threadMention: THREAD_OWNERSHIP_MENTION_SLOT,
  });
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: THREAD_OWNERSHIP_MENTION_SLOT,
    segments: [{ kind: "mention", mention }],
  });
}

export async function handleThreadOwnershipChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: HandleThreadOwnershipChangeArgs,
): Promise<void> {
  if (
    args.updatedThread.parentThreadId === args.previousThread.parentThreadId
  ) {
    return;
  }

  appendThreadOwnershipChangeEvent(deps, {
    threadId: args.updatedThread.id,
    environmentId: args.updatedThread.environmentId,
    previousParentThreadId: args.previousThread.parentThreadId,
    nextParentThreadId: args.updatedThread.parentThreadId,
  });

  if (args.updatedThread.parentThreadId) {
    await queueParentSystemMessageBestEffort(deps, {
      childThreadId: args.updatedThread.id,
      parentThreadId: args.updatedThread.parentThreadId,
      input: buildThreadOwnershipSystemInput(
        "systemMessageThreadOwnershipAssigned",
        args.updatedThread,
      ),
      reason: "assigned",
      templateId: "systemMessageThreadOwnershipAssigned",
      threadName: parentSystemThreadLabel(args.updatedThread),
    });
  }
  if (args.previousThread.parentThreadId) {
    await queueParentSystemMessageBestEffort(deps, {
      childThreadId: args.updatedThread.id,
      parentThreadId: args.previousThread.parentThreadId,
      input: buildThreadOwnershipSystemInput(
        "systemMessageThreadOwnershipRemoved",
        args.updatedThread,
      ),
      reason: "removed",
      templateId: "systemMessageThreadOwnershipRemoved",
      threadName: parentSystemThreadLabel(args.updatedThread),
    });
  }
}

function releaseUnarchivedChildrenFromArchivedThreadInTransaction(
  deps: ThreadOwnershipTransactionDeps,
  args: ReleaseUnarchivedChildrenFromArchivedThreadArgs,
): void {
  const childThreads = listUnarchivedAssignedChildThreads(deps.db, {
    parentThreadId: args.parentThreadId,
  });

  for (const childThread of childThreads) {
    const updatedThread = updateThread(deps.db, deps.hub, childThread.id, {
      parentThreadId: null,
    });
    if (!updatedThread) {
      continue;
    }
    appendThreadOwnershipChangeEventInTransaction(deps, {
      threadId: updatedThread.id,
      environmentId: updatedThread.environmentId,
      previousParentThreadId: childThread.parentThreadId,
      nextParentThreadId: updatedThread.parentThreadId,
    });
  }
}

export function archiveThreadAndReleaseChildren(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub">,
  args: ArchiveThreadAndReleaseChildrenArgs,
): Thread | null {
  const notificationBuffer = new NotificationBuffer();
  const result = deps.db.transaction(
    (tx) => {
      const archivedThread = archiveThread(
        tx,
        notificationBuffer,
        args.threadId,
      );
      if (!archivedThread) {
        return null;
      }

      releaseUnarchivedChildrenFromArchivedThreadInTransaction(
        {
          db: tx,
          hub: notificationBuffer,
        },
        {
          parentThreadId: archivedThread.id,
        },
      );

      return archivedThread;
    },
    { behavior: "immediate" },
  );

  notificationBuffer.flushInto(deps.hub);
  return result;
}
