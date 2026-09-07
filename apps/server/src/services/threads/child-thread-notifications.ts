import type {
  PromptInput,
  SystemMessageSubject,
  ThreadEventTurnStatus,
} from "@bb/domain";
import { listActiveBackgroundTaskCountsByThreadIds } from "@bb/db";
import { renderTemplate } from "@bb/templates";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  buildParentSystemInputFromTemplateSlot,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
  type ParentSystemInputSegment,
  type ParentSystemMessageTaxonomy,
  type ParentSystemRenderedMention,
  type ParentSystemThreadMentionSource,
} from "./parent-system-messages.js";
import {
  childOutcomeSystemMessageKind,
  systemMessageKindForTemplate,
} from "./system-message-kind.js";
import { getLastThreadOutput } from "./thread-data.js";

export type ChildThreadNotificationSource = ParentSystemThreadMentionSource;

export interface ChildThreadTurnNotificationBatchItem {
  activeWorkflowCount: number;
  childThread: ChildThreadNotificationSource;
  terminalOutput: string | null;
  turnStatus: ThreadEventTurnStatus;
}

interface ChildThreadTurnNotificationBatch {
  items: ChildThreadTurnNotificationBatchItem[];
  timer: ReturnType<typeof setTimeout>;
}

interface ChildThreadTurnStatusBatchLine {
  item: ChildThreadTurnNotificationBatchItem;
  mention: ParentSystemRenderedMention;
}

interface RenderChildThreadTurnStatusBatchTextArgs {
  lines: ChildThreadTurnStatusBatchLine[];
}

interface FormatChildThreadTurnStatusLineArgs {
  line: ChildThreadTurnStatusBatchLine;
}

interface BuildChildThreadTurnStatusBatchInputArgs {
  items: ChildThreadTurnNotificationBatchItem[];
}

interface BuildChildThreadNeedsAttentionInputArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
}

interface QueueChildThreadTurnNotificationArgs {
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
  turnStatus: ThreadEventTurnStatus;
}

interface QueueChildThreadNeedsAttentionNotificationArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
}

const CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS = 2_000;
const CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT =
  "__BB_CHILD_THREAD_OUTCOME_BATCH_UPDATES__";
const CHILD_THREAD_MENTION_SLOT = "__BB_CHILD_THREAD_MENTION__";
const CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT = 4_000;
const CHILD_THREAD_OUTPUT_TRUNCATION_MARKER = "\n\n[... output truncated ...]";
const CHILD_THREAD_INSPECTION_GUIDANCE =
  "Review the thread before deciding next steps.";
const CHILD_THREAD_INTERRUPTED_GUIDANCE =
  "If the user stopped it manually, do not resume, restart, retry, replace, or continue the work unless the user explicitly asks.";
const CHILD_THREAD_BATCH_INTERRUPTED_GUIDANCE =
  "If the user stopped any interrupted thread manually, do not resume, restart, retry, replace, or continue the work unless the user explicitly asks.";
const CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY =
  "It is blocked on a pending interaction.";
const CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE =
  "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.";
const CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE =
  "Threads with a workflow still running have not finished; they will report again when their workflow does.";
const childThreadTurnNotificationBatches = new Map<
  string,
  ChildThreadTurnNotificationBatch
>();

function childThreadTurnStatusLabel(turnStatus: ThreadEventTurnStatus): string {
  switch (turnStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "was interrupted";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

function truncateChildThreadOutput(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const retainedLength = Math.max(
    0,
    limit - CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.length,
  );
  if (retainedLength === 0) {
    return CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.trimStart();
  }
  return `${text.slice(0, retainedLength).trimEnd()}${CHILD_THREAD_OUTPUT_TRUNCATION_MARKER}`;
}

function formatChildThreadCompletionOutputExcerpt(
  output: string | null,
): string {
  const trimmedOutput = output?.trim();
  if (!trimmedOutput) {
    return "No final output was recorded.";
  }
  return truncateChildThreadOutput(
    trimmedOutput,
    CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT,
  );
}

function formatChildThreadNeedsAttentionSummary(
  summary: string | null,
): string {
  const trimmedSummary = summary?.trim();
  if (!trimmedSummary) {
    return CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY;
  }
  return trimmedSummary;
}

function formatChildThreadRunningWorkflowClause(count: number): string {
  if (count < 1) {
    return "";
  }
  return count === 1
    ? ", with 1 workflow still running"
    : `, with ${count} workflows still running`;
}

function buildSingleChildThreadTurnStatusSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;
  switch (line.item.turnStatus) {
    case "completed": {
      const workflowClause = formatChildThreadRunningWorkflowClause(
        line.item.activeWorkflowCount,
      );
      const workflowGuidance =
        workflowClause === ""
          ? ""
          : `\n\n${CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE}`;
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` completed${workflowClause}:\n\n${formatChildThreadCompletionOutputExcerpt(line.item.terminalOutput)}${workflowGuidance}`,
        },
      ];
    }
    case "failed":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` failed.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}`,
        },
      ];
    case "interrupted":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` was interrupted.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}\n\n${CHILD_THREAD_INTERRUPTED_GUIDANCE}`,
        },
      ];
    default: {
      const exhaustiveCheck: never = line.item.turnStatus;
      return exhaustiveCheck;
    }
  }
}

function buildChildThreadBatchStatusLineSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;
  const workflowClause = formatChildThreadRunningWorkflowClause(
    line.item.activeWorkflowCount,
  );
  return [
    { kind: "mention", mention: line.mention },
    {
      kind: "text",
      text: ` ${childThreadTurnStatusLabel(line.item.turnStatus)}${workflowClause}.`,
    },
  ];
}

function getChildThreadCompletionOutput(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): string | null {
  if (args.turnStatus !== "completed") {
    return null;
  }
  return getLastThreadOutput(deps.db, args.childThread.id);
}

function getChildThreadActiveWorkflowCount(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): number {
  const [activity] = listActiveBackgroundTaskCountsByThreadIds(deps.db, {
    threadIds: [args.childThread.id],
  });
  return activity?.activeWorkflowCount ?? 0;
}

function buildChildThreadTurnStatusBatchSegments(
  args: RenderChildThreadTurnStatusBatchTextArgs,
): ParentSystemInputSegment[] {
  if (args.lines.length === 1 && args.lines[0]) {
    return buildSingleChildThreadTurnStatusSegments({
      line: args.lines[0],
    });
  }

  const segments: ParentSystemInputSegment[] = [];
  segments.push({ kind: "text", text: "Child thread updates:" });
  args.lines.forEach((line, index) => {
    segments.push({ kind: "text", text: index === 0 ? "\n\n- " : "\n- " });
    segments.push(...buildChildThreadBatchStatusLineSegments({ line }));
  });
  if (args.lines.some((line) => line.item.turnStatus === "interrupted")) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_INTERRUPTED_GUIDANCE}`,
    });
  }
  if (args.lines.some((line) => line.item.activeWorkflowCount > 0)) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE}`,
    });
  }
  return segments;
}

function buildChildThreadTurnStatusBatchLines(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): ChildThreadTurnStatusBatchLine[] {
  return args.items.map((item) => ({
    item,
    mention: buildParentSystemThreadMention({
      thread: item.childThread,
    }),
  }));
}

function childThreadSubject(
  thread: ChildThreadNotificationSource,
): SystemMessageSubject {
  return {
    kind: "thread",
    threadId: thread.id,
    threadName: parentSystemThreadLabel(thread),
  };
}

function childThreadTurnStatusBatchTaxonomy(
  items: ChildThreadTurnNotificationBatchItem[],
): ParentSystemMessageTaxonomy {
  const single = items.length === 1 ? items[0] : undefined;
  if (single) {
    return {
      systemMessageKind: childOutcomeSystemMessageKind(single.turnStatus),
      systemMessageSubject: childThreadSubject(single.childThread),
    };
  }
  return {
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: { kind: "thread-batch", count: items.length },
  };
}

export function buildChildThreadTurnStatusBatchInput(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): PromptInput[] {
  const lines = buildChildThreadTurnStatusBatchLines(args);
  const renderedText = renderTemplate("systemMessageChildThreadOutcomeBatch", {
    updates: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
  });
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
    segments: buildChildThreadTurnStatusBatchSegments({ lines }),
  });
}

export function buildChildThreadNeedsAttentionInput(
  args: BuildChildThreadNeedsAttentionInputArgs,
): PromptInput[] {
  const mention = buildParentSystemThreadMention({
    thread: args.childThread,
  });
  const renderedText = renderTemplate(
    "systemMessageChildThreadNeedsAttention",
    {
      blockerSummary: formatChildThreadNeedsAttentionSummary(
        args.blockerSummary,
      ),
      threadMention: CHILD_THREAD_MENTION_SLOT,
    },
  );
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_MENTION_SLOT,
    segments: [{ kind: "mention", mention }],
  });
}

function childThreadTurnNotificationLogMessage(
  turnStatus: ThreadEventTurnStatus,
): string {
  switch (turnStatus) {
    case "completed":
      return "Failed to queue parent completed-thread notification";
    case "failed":
      return "Failed to queue parent failed-thread notification";
    case "interrupted":
      return "Failed to queue parent interrupted-thread notification";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

async function flushChildThreadTurnNotificationBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
): Promise<void> {
  const batch = childThreadTurnNotificationBatches.get(parentThreadId);
  if (!batch) {
    return;
  }
  childThreadTurnNotificationBatches.delete(parentThreadId);

  try {
    await queueParentSystemMessage(deps, {
      input: buildChildThreadTurnStatusBatchInput({
        items: batch.items,
      }),
      parentThreadId,
      ...childThreadTurnStatusBatchTaxonomy(batch.items),
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        parentThreadId,
        childThreads: batch.items.map((item) => ({
          childThreadId: item.childThread.id,
          turnStatus: item.turnStatus,
        })),
      },
      "Failed to queue batched parent turn notifications",
    );
  }
}

function scheduleChildThreadTurnNotificationBatchFlush(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void flushChildThreadTurnNotificationBatch(deps, parentThreadId);
  }, CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS);
}

function queueChildThreadTurnNotificationBatchItem(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): void {
  const item: ChildThreadTurnNotificationBatchItem = {
    activeWorkflowCount: getChildThreadActiveWorkflowCount(deps, args),
    childThread: args.childThread,
    terminalOutput: getChildThreadCompletionOutput(deps, args),
    turnStatus: args.turnStatus,
  };
  const existingBatch = childThreadTurnNotificationBatches.get(
    args.parentThreadId,
  );
  if (existingBatch) {
    const existingIndex = existingBatch.items.findIndex(
      (entry) => entry.childThread.id === args.childThread.id,
    );
    if (existingIndex === -1) {
      existingBatch.items.push(item);
    } else {
      existingBatch.items[existingIndex] = item;
    }
    clearTimeout(existingBatch.timer);
    existingBatch.timer = scheduleChildThreadTurnNotificationBatchFlush(
      deps,
      args.parentThreadId,
    );
    return;
  }

  childThreadTurnNotificationBatches.set(args.parentThreadId, {
    items: [item],
    timer: scheduleChildThreadTurnNotificationBatchFlush(
      deps,
      args.parentThreadId,
    ),
  });
}

export async function queueChildThreadTurnNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): Promise<void> {
  try {
    queueChildThreadTurnNotificationBatchItem(deps, args);
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        turnStatus: args.turnStatus,
        err: error,
      },
      childThreadTurnNotificationLogMessage(args.turnStatus),
    );
  }
}

export async function queueChildThreadNeedsAttentionNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadNeedsAttentionNotificationArgs,
): Promise<void> {
  try {
    await queueParentSystemMessage(deps, {
      input: buildChildThreadNeedsAttentionInput({
        blockerSummary: args.blockerSummary,
        childThread: args.childThread,
      }),
      parentThreadId: args.parentThreadId,
      systemMessageKind: systemMessageKindForTemplate(
        "systemMessageChildThreadNeedsAttention",
      ),
      systemMessageSubject: childThreadSubject(args.childThread),
    });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        err: error,
      },
      "Failed to queue parent needs-attention notification",
    );
  }
}
