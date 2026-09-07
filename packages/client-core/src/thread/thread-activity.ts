import { assertNever } from "@bb/core-ui";
import type {
  Thread,
  ThreadListEntry,
  ThreadQueuedWork,
  ThreadWithRuntime,
} from "@bb/domain";
// Imported from the defining leaf module, not the timeline barrel: the sidebar
// thread list reaches this helper before first paint, and the barrel would pull
// the whole timeline (and @pierre/diffs, Shiki, KaTeX behind it) onto the boot
// path for one predicate.
import { isRunningThreadRuntimeDisplayStatus } from "../timeline/thread-runtime-status.js";
import { isThreadRead } from "./thread-read-state.js";

type ThreadStatusShape = Pick<
  Thread,
  "status" | "lastReadAt" | "latestAttentionAt" | "parentThreadId"
>;

type ThreadRuntimeShape = Pick<ThreadWithRuntime, "runtime">;
type ThreadActivityStateShape = Pick<ThreadListEntry, "activity">;

export function isRuntimeBusyThread(thread: ThreadRuntimeShape): boolean {
  return isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus);
}

export function hasActiveWorkflowActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activeWorkflowCount > 0;
}

export function hasActiveBackgroundAgentActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activeBackgroundAgentCount > 0;
}

export function hasActiveBackgroundCommandActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activeBackgroundCommandCount > 0;
}

export function hasActivePlanModeActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activePlanModeCount > 0;
}

export function hasActiveGoalActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activeGoalCount > 0;
}

export function isBusyThread(
  thread: ThreadRuntimeShape & ThreadActivityStateShape,
): boolean {
  return (
    isRuntimeBusyThread(thread) ||
    hasActiveWorkflowActivity(thread) ||
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveBackgroundCommandActivity(thread) ||
    hasActivePlanModeActivity(thread) ||
    hasActiveGoalActivity(thread)
  );
}

export interface ThreadListIndicatorState {
  hasPendingInteraction: boolean;
  hasUnsubmittedDraft: boolean;
  hasUnreadError: boolean;
  hasUnreadSuccess: boolean;
  isBackgroundAgentActive: boolean;
  isBackgroundCommandActive: boolean;
  isGoalActive: boolean;
  isPlanModeActive: boolean;
  isRuntimeActive: boolean;
  isWorkflowActive: boolean;
  /**
   * Whether the thread has work waiting on its queue. Read straight off the list
   * entry rather than inferred from the thread's status: a `pending` thread is
   * only the most obvious case, and an idle thread with a scheduled send or a
   * plugin-queued follow-up is waiting just as much.
   */
  queuedWork: ThreadQueuedWork;
}

export type ThreadListIndicatorKind =
  | "unread-error"
  | "waiting-for-input"
  | "working-draft"
  | "workflow"
  | "background-agent"
  | "background-command"
  | "plan-mode"
  | "goal"
  | "runtime"
  | "queued-failed"
  | "queued-waiting"
  | "draft"
  | "unread-success"
  | "none";

const THREAD_LIST_INDICATOR_LABELS: Record<
  Exclude<ThreadListIndicatorKind, "none">,
  string
> = {
  "unread-error": "Unread thread failed",
  "waiting-for-input": "Thread needs user input",
  "working-draft": "Thread working with unsubmitted draft",
  workflow: "Workflow running",
  "background-agent": "Background agent running",
  "background-command": "Background command running",
  "plan-mode": "Plan mode active",
  goal: "Goal active",
  runtime: "Thread working",
  "queued-failed": "Queued message failed to send",
  "queued-waiting": "Thread has a message waiting to send",
  draft: "Thread has unsubmitted draft",
  "unread-success": "Unread thread succeeded",
};

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
): string | null {
  return kind === "none" ? null : THREAD_LIST_INDICATOR_LABELS[kind];
}

export function hasThreadListWorkingActivity(
  state: ThreadListIndicatorState,
  hasRunningPluginStatus = false,
): boolean {
  return (
    state.isRuntimeActive ||
    state.isWorkflowActive ||
    state.isBackgroundAgentActive ||
    state.isBackgroundCommandActive ||
    state.isPlanModeActive ||
    state.isGoalActive ||
    hasRunningPluginStatus
  );
}

export function resolveThreadListIndicator(
  state: ThreadListIndicatorState,
): ThreadListIndicatorKind {
  if (state.hasUnreadError) return "unread-error";
  if (state.hasPendingInteraction) return "waiting-for-input";

  const hasActiveWork = hasThreadListWorkingActivity(state);
  if (state.hasUnsubmittedDraft && hasActiveWork) return "working-draft";
  if (state.isPlanModeActive) return "plan-mode";
  if (state.isGoalActive) return "goal";
  if (state.isRuntimeActive) return "runtime";
  if (state.isWorkflowActive) return "workflow";
  if (state.isBackgroundAgentActive) return "background-agent";
  if (state.isBackgroundCommandActive) return "background-command";
  // Queued work outranks a draft: the draft is the user's to send whenever,
  // while a queued row is work already committed that has not run yet. It sits
  // below every working arm above deliberately — a thread that is BOTH running
  // and holding a queued follow-up is best described by what it is doing, and
  // the queue rows above its composer say the rest.
  if (state.queuedWork === "failed") return "queued-failed";
  if (state.queuedWork === "waiting") return "queued-waiting";
  if (state.hasUnsubmittedDraft) return "draft";
  if (state.hasUnreadSuccess) return "unread-success";
  return "none";
}

export interface CollapsedChildActivity {
  pending: boolean;
  working: boolean;
  hasUnsubmittedDraft: boolean;
  runtimeWorking: boolean;
  workflow: boolean;
  backgroundAgent: boolean;
  backgroundCommand: boolean;
  planMode: boolean;
  goal: boolean;
  unread: boolean;
  unreadError: boolean;
}

export const NO_COLLAPSED_CHILD_ACTIVITY: CollapsedChildActivity = {
  pending: false,
  working: false,
  hasUnsubmittedDraft: false,
  runtimeWorking: false,
  workflow: false,
  backgroundAgent: false,
  backgroundCommand: false,
  planMode: false,
  goal: false,
  unread: false,
  unreadError: false,
};

type ThreadActivityShape = ThreadStatusShape &
  ThreadRuntimeShape &
  Pick<ThreadListEntry, "id" | "activity" | "hasPendingInteraction">;

const EMPTY_DRAFT_THREAD_IDS: ReadonlySet<string> = new Set();

export function getCollapsedChildActivity(
  threads: readonly ThreadActivityShape[],
  draftThreadIds: ReadonlySet<string> = EMPTY_DRAFT_THREAD_IDS,
): CollapsedChildActivity {
  let pending = false;
  let working = false;
  let hasUnsubmittedDraft = false;
  let runtimeWorking = false;
  let workflow = false;
  let backgroundAgent = false;
  let backgroundCommand = false;
  let planMode = false;
  let goal = false;
  let unread = false;
  let unreadError = false;
  for (const thread of threads) {
    if (draftThreadIds.has(thread.id)) {
      hasUnsubmittedDraft = true;
    }
    const childUnreadDone = isUnreadDoneThread(thread);
    if (childUnreadDone && thread.status === "error") {
      unreadError = true;
    } else if (childUnreadDone) {
      unread = true;
    }

    if (thread.hasPendingInteraction) {
      pending = true;
    }
    if (isBusyThread(thread)) working = true;
    if (isRuntimeBusyThread(thread)) runtimeWorking = true;
    if (hasActiveWorkflowActivity(thread)) workflow = true;
    if (hasActiveBackgroundAgentActivity(thread)) backgroundAgent = true;
    if (hasActiveBackgroundCommandActivity(thread)) backgroundCommand = true;
    if (hasActivePlanModeActivity(thread)) planMode = true;
    if (hasActiveGoalActivity(thread)) goal = true;
  }
  return {
    pending,
    working,
    hasUnsubmittedDraft,
    runtimeWorking,
    workflow,
    backgroundAgent,
    backgroundCommand,
    planMode,
    goal,
    unread,
    unreadError,
  };
}

export function isUnreadDoneThread(thread: ThreadStatusShape): boolean {
  if (thread.parentThreadId != null) {
    return false;
  }

  switch (thread.status) {
    case "error":
    case "idle":
      return !isThreadRead(thread);
    case "active":
    case "starting":
    case "stopping":
    // A pending thread has never run, so it has no outcome to be unread
    // about; it is waiting, not done.
    case "pending":
      return false;
    default:
      return assertNever(thread.status);
  }
}
