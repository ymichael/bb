// Testbed for the full streaming + pinning + height-animation stack. Each
// variant renders inside a production-mirroring stage (`PageShell` with
// bottom-anchor scroll wrapping `ConversationTimeline` and
// `ThreadTimelineRows`) and ticks through a scripted streaming sequence, so
// changes to the timeline's container height transitions, scroll-pin
// behavior, or markdown body resize can be evaluated against realistic
// structural shapes:
//
//  - optimistic user message: simulates the optimistic→server row swap.
//  - working / thinking indicator: HeightTransition enter/exit on a toggling
//    indicator below a static rows context.
//  - assistant messages: top-level conversation rows arriving one at a time.
//  - assistant content streaming: a single assistant row stays mounted while
//    its markdown body grows sentence-by-sentence through `\n\n` breaks,
//    bullet lists, and a fenced code block.
//  - bundle children: tool rows append into the trailing exploration bundle,
//    exercising both top-level and nested `TimelineRowsList` row insertion
//    plus the bundle's internal sticky-bottom catch-up.
//
// Each variant has its own Pause and Restart so a frame can be held for
// inspection. All variants are paused by default.
import { useEffect, useState, type ReactNode } from "react";
import type { TimelineRow } from "@bb/server-contract";
import {
  ThreadTimelineRows,
  TimelineWorkingIndicator,
} from "@/components/thread/timeline";
import { ConversationTimeline } from "@/components/ui/conversation.js";
import { HeightTransition } from "@/components/ui/height-transition.js";
import { PageShell } from "@/components/ui/page-shell.js";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/Streaming",
};

const baseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  threadRuntimeDisplayStatus: "active" as const,
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
  workspaceRootPath: undefined,
};

const THREAD_ID = "thr_streaming_rows";

// Mirrors the production ThreadTimelinePane structure so the story exercises
// the same scroll/pin/spacing path: PageShell with bottom-anchor scroll
// wrapping ConversationTimeline (gap-1 between rows + ongoing indicator).
// Fixed-height parent so the scroll area is bounded and the pin is engaged.
function PinnedTimelineStage({
  rows,
  indicator,
  showIndicator,
  cycle = 0,
}: {
  rows: readonly TimelineRow[];
  indicator: ReactNode;
  showIndicator: boolean;
  // Threaded into `turnSummaryRowsIdentity` so consumers can observe the
  // story re-mounting the row list each loop cycle if needed.
  cycle?: number;
}) {
  return (
    // `overflow-anchor: none` on the stage container so the browser's
    // page-level scroll anchoring doesn't pick an element inside a tick-
    // animating story (motion-driven height changes inside a `<p>` or `<li>`)
    // as its page anchor — otherwise the whole page silently shifts as inner
    // content settles. Internal sticky-bottom inside `BottomAnchoredScrollBody`
    // is unaffected; it owns the inner scroll element directly.
    <div
      className="flex h-[360px] w-full max-w-[760px] flex-col rounded-md border border-border bg-background"
      style={{ overflowAnchor: "none" }}
    >
      <PageShell
        scrollBehavior="bottom-anchor"
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="min-h-full gap-2 pt-4"
        maxWidthClassName="max-w-none"
      >
        <ConversationTimeline className="flex-1">
          <ThreadTimelineRows
            key={`cycle-${cycle}`}
            {...baseProps}
            turnSummaryRowsIdentity={`story-cycle-${cycle}`}
            timelineRows={rows.slice()}
          />
          <HeightTransition visible={showIndicator}>{indicator}</HeightTransition>
        </ConversationTimeline>
      </PageShell>
    </div>
  );
}

function StreamingLabel({
  title,
  hint,
  onRestart,
  isPaused,
  onTogglePause,
}: {
  title: string;
  hint: string;
  onRestart: () => void;
  isPaused: boolean;
  onTogglePause: () => void;
}) {
  return (
    <span className="flex flex-col items-start gap-2">
      <span className="text-sm text-muted-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
      <span className="flex gap-2">
        <button
          type="button"
          onClick={onTogglePause}
          className="rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground hover:bg-accent"
        >
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground hover:bg-accent"
        >
          Restart
        </button>
      </span>
    </span>
  );
}

// Cycles 0 → totalSteps, holds at totalSteps for `pauseTicks` more intervals,
// then wraps back to 0 — so the demo replays continuously. `cycle` increments
// each wrap so consumers can re-key affected subtrees if needed. `isPaused`
// halts ticking without resetting the counter; resuming continues from the
// same step. `restartKey` resets the counter to 0 on change.
function useStreamingTickLoop(
  totalSteps: number,
  intervalMs: number,
  pauseTicks: number,
  restartKey: number,
  isPaused: boolean,
): { step: number; cycle: number } {
  const [counter, setCounter] = useState(0);
  useEffect(() => {
    setCounter(0);
  }, [restartKey]);
  useEffect(() => {
    if (isPaused) return;
    const cycleLength = totalSteps + pauseTicks;
    if (cycleLength === 0) return;
    const id = window.setInterval(() => {
      setCounter((current) => current + 1);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [totalSteps, intervalMs, pauseTicks, isPaused]);
  const cycleLength = totalSteps + pauseTicks;
  if (cycleLength === 0) return { step: 0, cycle: 0 };
  return {
    step: Math.min(counter % cycleLength, totalSteps),
    cycle: Math.floor(counter / cycleLength),
  };
}

// ---------------------------------------------------------------------------
// Variant 0 — optimistic user message swap. Simulates the optimistic →
// server row swap: an optimistic user row mounts, then the server row
// replaces it. The two rows have different ids but identical content; the
// container's height transition absorbs the swap without flicker because
// per-row mount animations were intentionally removed in favor of a single
// outer height transition.
// ---------------------------------------------------------------------------

const OPTIMISTIC_USER_PROMPT_TEXT =
  "Can you also trace the retry policy module?";

function buildOptimisticUserRow(id: string): TimelineRow {
  return {
    id,
    threadId: THREAD_ID,
    turnId: `${id}-turn`,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 0,
    createdAt: 0,
    kind: "conversation",
    role: "user",
    text: OPTIMISTIC_USER_PROMPT_TEXT,
    attachments: null,
    userRequest: { kind: "message", status: "accepted" },
  };
}

function OptimisticUserMessageFlicker({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
  // Three phases per cycle: empty → optimistic → real. The interval is short
  // enough that the optimistic row's mount animation is still in flight when
  // the real row replaces it, reproducing the visible "animate twice" jank.
  const { step, cycle } = useStreamingTickLoop(2, 200, 18, restartKey, isPaused);
  const rows: TimelineRow[] = [];
  if (step === 1) {
    rows.push(buildOptimisticUserRow("user-optimistic"));
  } else if (step === 2) {
    rows.push(buildOptimisticUserRow("user-real"));
  }
  return (
    <PinnedTimelineStage
      rows={rows}
      indicator={<TimelineWorkingIndicator />}
      showIndicator={step >= 1}
      cycle={cycle}
    />
  );
}

// ---------------------------------------------------------------------------
// Variant 1 — assistant message arrivals. Top-level conversation rows mount
// one at a time. This is the surface a "grow from 0 height + fade" transition
// would land on.
// ---------------------------------------------------------------------------

interface ConversationStep {
  role: "user" | "assistant";
  text: string;
}

const CONVERSATION_STEPS: readonly ConversationStep[] = [
  {
    role: "user",
    text: "Can you help me find where we track command failures?",
  },
  {
    role: "assistant",
    text: "Sure — let me search the codebase.",
  },
  {
    role: "assistant",
    text: "Found it in `services/commands/failure-tracker.ts`.\n\nThe module emits a `command_failure` system row whenever a host daemon reports a non-zero exit code. Each event carries the full command line, the exit code, the stderr tail (last 4KB), the elapsed wall time, and the originating turn's request id.\n\nDownstream that same record is consumed by both the retry-policy module and the observability sink — any change here needs to keep both contracts intact.",
  },
  {
    role: "user",
    text: "Thanks. Can you also check the retry logic?",
  },
  {
    role: "assistant",
    text: "Looking at the retry policy now.",
  },
  {
    role: "assistant",
    text: "Retries use exponential backoff (250ms → 500ms → 1s) capped at three attempts. After exhaustion the failure surfaces to the thread with a `command_failure_exhausted` system row and the turn ends.\n\nThere's a special case for `recoverable: false` errors — shell-not-found, executable-not-found, and permission-denied skip retries entirely and surface immediately.",
  },
  {
    role: "user",
    text: "Where do we decide what counts as recoverable?",
  },
  {
    role: "assistant",
    text: "The classifier lives in `services/commands/recoverable.ts`.",
  },
  {
    role: "assistant",
    text: "It's a small lookup keyed on the daemon's structured error code. Most signal-driven exits (SIGTERM, SIGKILL) and timeout codes are flagged recoverable; cases where the OS reports the binary itself was missing or unauthorized are not.\n\nThe classifier returns `{ recoverable: boolean, surfaceMessage: string }` so the retry policy and the failure-tracker speak in the same shape.",
  },
  {
    role: "user",
    text: "And what gets shown in the UI on the final attempt?",
  },
  {
    role: "assistant",
    text: "On the final attempt — recoverable or not — the timeline gets a single `command_failure_exhausted` system row. Its title is the `surfaceMessage` from the classifier and the detail is the joined stderr tails from each attempt.\n\nIn the row chrome, the exit code badge is highlighted and the retry count chip reads `3/3`. Hovering it reveals the per-attempt timings.\n\nIf the user later retries the turn manually, a fresh tracker is allocated; the old failure row stays in place as history.",
  },
];

function conversationRowFromStep(
  step: ConversationStep,
  index: number,
): TimelineRow {
  const base = {
    id: `streaming-rows-conversation-${index}`,
    threadId: THREAD_ID,
    turnId: `streaming-rows-turn-${index}`,
    sourceSeqStart: index + 1,
    sourceSeqEnd: index + 1,
    startedAt: index,
    createdAt: index,
    kind: "conversation" as const,
    text: step.text,
    attachments: null,
  };
  if (step.role === "user") {
    return {
      ...base,
      role: "user",
      userRequest: { kind: "message", status: "accepted" },
    };
  }
  return {
    ...base,
    role: "assistant",
    userRequest: null,
  };
}

function ConversationRowsArriving({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
  const { step, cycle } = useStreamingTickLoop(
    CONVERSATION_STEPS.length,
    1500,
    3,
    restartKey,
    isPaused,
  );
  const rows = CONVERSATION_STEPS.slice(0, step).map(conversationRowFromStep);
  const isStreaming = step < CONVERSATION_STEPS.length;
  return (
    <PinnedTimelineStage
      rows={rows}
      indicator={<TimelineWorkingIndicator />}
      showIndicator={isStreaming}
      cycle={cycle}
    />
  );
}

// ---------------------------------------------------------------------------
// Variant 2 — working/thinking indicator toggling. The indicator is the
// other surface that benefits from an enter/exit height transition since it
// appears and disappears between turns.
// ---------------------------------------------------------------------------

// A static turn rendered above the toggling indicator so the layout shift is
// visible when the indicator appears/disappears under bottom-pin. Sized to
// comfortably overflow the 360px stage so the scroll area is engaged.
const INDICATOR_CONTEXT_STEPS: readonly ConversationStep[] = [
  {
    role: "user",
    text: "Walk me through how the timeline pins to the bottom.",
  },
  {
    role: "assistant",
    text: "While the user is at the bottom, a class on the content sets `overflow-anchor: none` on every child and re-targets the browser's scroll anchor to a 1px sentinel at the end.\n\nA ResizeObserver-driven rAF loop also re-pins scrollTop to the maximum on layout changes that browser anchoring misses, like sidebar collapse or prompt-box resize.",
  },
  {
    role: "user",
    text: "What happens when the user scrolls up to read history?",
  },
  {
    role: "assistant",
    text: "User intent is inferred from wheel, touch, keyboard, and pointer-drag events. As soon as one of those fires and a `scroll` event leaves the bottom threshold, we mark the sticky ref `false` and remove the anchor class.\n\nFrom then on the browser's default scroll anchoring (any visible element) takes over, so the row the user is reading stays put even as content settles below.",
  },
  {
    role: "user",
    text: "And what wakes the pin back up?",
  },
  {
    role: "assistant",
    text: "Two paths: scrolling back within 4px of the bottom, or clicking the floating scroll-to-bottom pill in the prompt box. Either flips the sticky ref back to `true` and re-applies the anchor class on the next render.",
  },
];

const INDICATOR_CONTEXT_ROWS: readonly TimelineRow[] =
  INDICATOR_CONTEXT_STEPS.map(conversationRowFromStep);

// ---------------------------------------------------------------------------
// Variant 3 — content streaming inside an already-mounted assistant row.
// The row mounts once with the user prompt above it, then the markdown body
// grows sentence by sentence — exercising row resize rather than row mount.
// ---------------------------------------------------------------------------

const ASSISTANT_STREAMING_USER_PROMPT: ConversationStep = {
  role: "user",
  text: "Trace how a command failure surfaces in the timeline — what files are involved?",
};

// Chunks already carry their own separators (`\n\n`, `\n- `, ` `) so the
// running body is built by joining with the empty string. Mixes paragraph
// breaks, an inline bullet list, and a fenced code block so the demo
// exercises real markdown structure changes — paragraph extensions stay in
// the same `<p>`, while `\n\n` / lists / code blocks add new top-level
// blocks that the eye reads as discrete structural events.
const ASSISTANT_STREAMING_CHUNKS: readonly string[] = [
  "Sure — let me trace it from the daemon up to the UI.",
  "\n\nI started with `services/commands/failure-tracker.ts` to see how the host daemon's exit-code events get turned into thread rows.",
  " The module emits a `command_failure` system row whenever a daemon reports a non-zero exit code.",
  "\n\nEach event carries:",
  "\n- the full command line and exit code",
  "\n- the stderr tail (last 4KB)",
  "\n- the elapsed wall time",
  "\n- the originating turn's request id",
  "\n\nDownstream the same record is consumed by both the retry-policy module and the observability sink — any change here needs to keep both contracts intact.",
  "\n\nThe retry side looks roughly like this:",
  "\n\n```ts\nasync function attempt(cmd, n = 1) {\n  const r = await run(cmd);\n  if (r.exitCode === 0) return r;\n  if (n >= 3) return surface(r);\n  await delay(backoff(n));\n  return attempt(cmd, n + 1);\n}\n```",
  "\n\nAfter exhaustion the failure surfaces to the thread with a `command_failure_exhausted` system row and the turn ends.",
  "\n\nThere's a special case for `recoverable: false` errors — shell-not-found, executable-not-found, and permission-denied skip retries entirely.",
];

function AssistantContentStreaming({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
  const { step, cycle } = useStreamingTickLoop(
    ASSISTANT_STREAMING_CHUNKS.length,
    500,
    4,
    restartKey,
    isPaused,
  );
  // Shared turn id so the assistant reply is grouped under the user prompt
  // like a real turn. `sourceSeqEnd` on the assistant row advances each tick
  // — the row memo's signature comparator (timelineRowSignatures.ts) omits
  // text/output deliberately and relies on the source sequence advancing to
  // invalidate the memo on in-place mutations.
  const turnId = "streaming-rows-content-turn";
  const userRow: TimelineRow = {
    id: "streaming-rows-content-user",
    threadId: THREAD_ID,
    turnId,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 0,
    createdAt: 0,
    kind: "conversation",
    role: "user",
    text: ASSISTANT_STREAMING_USER_PROMPT.text,
    attachments: null,
    userRequest: { kind: "message", status: "accepted" },
  };
  const assistantText = ASSISTANT_STREAMING_CHUNKS.slice(0, step).join("");
  const assistantRow: TimelineRow = {
    id: "streaming-rows-content-assistant",
    threadId: THREAD_ID,
    turnId,
    sourceSeqStart: 2,
    sourceSeqEnd: 2 + step,
    startedAt: 1,
    createdAt: 1,
    kind: "conversation",
    role: "assistant",
    text: assistantText,
    attachments: null,
    userRequest: null,
  };
  const rows: TimelineRow[] = [userRow];
  if (step > 0) {
    rows.push(assistantRow);
  }
  const isStreaming = step < ASSISTANT_STREAMING_CHUNKS.length;
  return (
    <PinnedTimelineStage
      rows={rows}
      indicator={<TimelineWorkingIndicator />}
      showIndicator={isStreaming}
      cycle={cycle}
    />
  );
}

// ---------------------------------------------------------------------------
// Variant 4 — bundle children arriving. New tool rows append one at a time
// into the trailing exploration bundle. Once two or more land in the same
// run, the projection groups them under a bundle-summary that shimmers as
// the active-latest frontier.
// ---------------------------------------------------------------------------

interface ExplorationStep {
  callId: string;
  toolName: "Read" | "Grep" | "Glob";
  toolArgs: Record<string, string | number>;
  intent:
    | { type: "read"; name: string; path: string }
    | { type: "search"; query: string; path: string }
    | { type: "list_files"; path: string };
}

const BUNDLE_LEAD_IN_STEPS: readonly ConversationStep[] = [
  {
    role: "user",
    text: "Trace how a command failure surfaces in the timeline — what files are involved?",
  },
  {
    role: "assistant",
    text: "Sure — I'll trace it from the daemon up to the UI.\n\nStarting with the failure-tracker module to see how the host daemon's exit-code events get turned into thread rows, then following the same record through the retry-policy and the surfaceMessage classifier on the server side.\n\nAfter that I'll jump to the React renderer that paints the failure badge and the retry-count chip, so we have the full path end to end.",
  },
  {
    role: "user",
    text: "Sounds good. Mind also flagging where the test coverage lives?",
  },
  {
    role: "assistant",
    text: "Will do — I'll glob for the relevant `*.test.ts` files alongside the implementation reads so we can spot any gaps.",
  },
];

const BUNDLE_LEAD_IN_ROWS: readonly TimelineRow[] = BUNDLE_LEAD_IN_STEPS.map(
  conversationRowFromStep,
);

const BUNDLE_EXPLORATION_STEPS: readonly ExplorationStep[] = [
  {
    callId: "bundle_read_failure_tracker",
    toolName: "Read",
    toolArgs: {
      file_path: "apps/server/src/services/commands/failure-tracker.ts",
    },
    intent: {
      type: "read",
      name: "failure-tracker.ts",
      path: "apps/server/src/services/commands/failure-tracker.ts",
    },
  },
  {
    callId: "bundle_grep_command_failure",
    toolName: "Grep",
    toolArgs: { pattern: "command_failure", path: "apps/server/src" },
    intent: {
      type: "search",
      query: "command_failure",
      path: "apps/server/src",
    },
  },
  {
    callId: "bundle_read_recoverable",
    toolName: "Read",
    toolArgs: {
      file_path: "apps/server/src/services/commands/recoverable.ts",
    },
    intent: {
      type: "read",
      name: "recoverable.ts",
      path: "apps/server/src/services/commands/recoverable.ts",
    },
  },
  {
    callId: "bundle_glob_retry_tests",
    toolName: "Glob",
    toolArgs: { pattern: "apps/server/test/commands/*.test.ts" },
    intent: { type: "list_files", path: "apps/server/test/commands" },
  },
  {
    callId: "bundle_grep_command_failure_exhausted",
    toolName: "Grep",
    toolArgs: {
      pattern: "command_failure_exhausted",
      path: "packages/thread-view/src",
    },
    intent: {
      type: "search",
      query: "command_failure_exhausted",
      path: "packages/thread-view/src",
    },
  },
  {
    callId: "bundle_read_system_row",
    toolName: "Read",
    toolArgs: { file_path: "packages/thread-view/src/system-row.ts" },
    intent: {
      type: "read",
      name: "system-row.ts",
      path: "packages/thread-view/src/system-row.ts",
    },
  },
  {
    callId: "bundle_grep_surface_message",
    toolName: "Grep",
    toolArgs: { pattern: "surfaceMessage", path: "apps/server/src" },
    intent: {
      type: "search",
      query: "surfaceMessage",
      path: "apps/server/src",
    },
  },
  {
    callId: "bundle_read_retry_policy",
    toolName: "Read",
    toolArgs: { file_path: "apps/server/src/services/commands/retry.ts" },
    intent: {
      type: "read",
      name: "retry.ts",
      path: "apps/server/src/services/commands/retry.ts",
    },
  },
  {
    callId: "bundle_glob_failure_renderers",
    toolName: "Glob",
    toolArgs: { pattern: "apps/app/src/components/thread/**/Failure*.tsx" },
    intent: {
      type: "list_files",
      path: "apps/app/src/components/thread",
    },
  },
  {
    callId: "bundle_grep_retry_chip",
    toolName: "Grep",
    toolArgs: { pattern: "retry count chip", path: "apps/app/src" },
    intent: {
      type: "search",
      query: "retry count chip",
      path: "apps/app/src",
    },
  },
  {
    callId: "bundle_read_failure_badge",
    toolName: "Read",
    toolArgs: {
      file_path: "apps/app/src/components/thread/FailureBadge.tsx",
    },
    intent: {
      type: "read",
      name: "FailureBadge.tsx",
      path: "apps/app/src/components/thread/FailureBadge.tsx",
    },
  },
  {
    callId: "bundle_grep_classifier",
    toolName: "Grep",
    toolArgs: { pattern: "classifier", path: "apps/server/src/services" },
    intent: {
      type: "search",
      query: "classifier",
      path: "apps/server/src/services",
    },
  },
  {
    callId: "bundle_read_telemetry_sink",
    toolName: "Read",
    toolArgs: {
      file_path: "apps/server/src/services/observability/sink.ts",
    },
    intent: {
      type: "read",
      name: "sink.ts",
      path: "apps/server/src/services/observability/sink.ts",
    },
  },
  {
    callId: "bundle_grep_emit_failure",
    toolName: "Grep",
    toolArgs: { pattern: "emitFailure", path: "apps/server/src" },
    intent: {
      type: "search",
      query: "emitFailure",
      path: "apps/server/src",
    },
  },
  {
    callId: "bundle_glob_failure_fixtures",
    toolName: "Glob",
    toolArgs: { pattern: "apps/server/test/fixtures/command-failures/*.json" },
    intent: {
      type: "list_files",
      path: "apps/server/test/fixtures/command-failures",
    },
  },
  {
    callId: "bundle_read_thread_view_system_row",
    toolName: "Read",
    toolArgs: {
      file_path: "packages/thread-view/src/system-row-renderer.ts",
    },
    intent: {
      type: "read",
      name: "system-row-renderer.ts",
      path: "packages/thread-view/src/system-row-renderer.ts",
    },
  },
  {
    callId: "bundle_grep_failure_badge",
    toolName: "Grep",
    toolArgs: { pattern: "FailureBadge", path: "apps/app/src" },
    intent: {
      type: "search",
      query: "FailureBadge",
      path: "apps/app/src",
    },
  },
  {
    callId: "bundle_read_failure_badge_test",
    toolName: "Read",
    toolArgs: {
      file_path: "apps/app/src/components/thread/FailureBadge.test.tsx",
    },
    intent: {
      type: "read",
      name: "FailureBadge.test.tsx",
      path: "apps/app/src/components/thread/FailureBadge.test.tsx",
    },
  },
  {
    callId: "bundle_glob_retry_renderers",
    toolName: "Glob",
    toolArgs: {
      pattern: "apps/app/src/components/thread/**/RetryChip*.tsx",
    },
    intent: {
      type: "list_files",
      path: "apps/app/src/components/thread",
    },
  },
];

function bundleExplorationRow(
  step: ExplorationStep,
  seq: number,
): TimelineRow {
  return {
    id: `streaming-rows-bundle:${step.callId}`,
    threadId: THREAD_ID,
    turnId: "streaming-rows-bundle-turn",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: seq,
    createdAt: seq,
    kind: "work",
    workKind: "tool",
    status: "completed",
    callId: step.callId,
    toolName: step.toolName,
    toolArgs: step.toolArgs,
    output: "",
    completedAt: seq,
    approvalStatus: null,
    activityIntents: [
      step.intent.type === "read"
        ? {
            type: "read",
            command: step.toolName,
            name: step.intent.name,
            path: step.intent.path,
          }
        : step.intent.type === "search"
          ? {
              type: "search",
              command: step.toolName,
              query: step.intent.query,
              path: step.intent.path,
            }
          : {
              type: "list_files",
              command: step.toolName,
              path: step.intent.path,
            },
    ],
  };
}

function BundleChildrenArriving({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
  // Pacing tightened so streaming through ~20 rows lands in a reasonable
  // demo cycle while still being slow enough to read each new row.
  const { step, cycle } = useStreamingTickLoop(
    BUNDLE_EXPLORATION_STEPS.length,
    800,
    4,
    restartKey,
    isPaused,
  );
  const bundleRows = BUNDLE_EXPLORATION_STEPS.slice(0, step).map(
    (stepData, index) =>
      bundleExplorationRow(stepData, BUNDLE_LEAD_IN_ROWS.length + index + 1),
  );
  const rows = [...BUNDLE_LEAD_IN_ROWS, ...bundleRows];
  const isStreaming = step < BUNDLE_EXPLORATION_STEPS.length;
  return (
    <PinnedTimelineStage
      rows={rows}
      indicator={<TimelineWorkingIndicator />}
      showIndicator={isStreaming}
      cycle={cycle}
    />
  );
}

// Cycle: none → working → thinking → working → (back to none). Each phase
// holds for one interval. Captures the realistic shape of a turn: idle
// before the assistant starts, work + reasoning interleavings, then idle
// again once the turn settles.
const INDICATOR_PHASE_SEQUENCE: readonly ("none" | "working" | "thinking")[] = [
  "none",
  "working",
  "thinking",
  "working",
];

function WorkingIndicatorToggling({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
  const [phaseIndex, setPhaseIndex] = useState(0);
  useEffect(() => {
    setPhaseIndex(0);
  }, [restartKey]);
  useEffect(() => {
    if (isPaused) return;
    const id = window.setInterval(() => {
      setPhaseIndex(
        (current) => (current + 1) % INDICATOR_PHASE_SEQUENCE.length,
      );
    }, 1500);
    return () => window.clearInterval(id);
  }, [isPaused]);
  const phase = INDICATOR_PHASE_SEQUENCE[phaseIndex];
  const visible = phase !== "none";
  const isThinking = phase === "thinking";
  return (
    <PinnedTimelineStage
      rows={INDICATOR_CONTEXT_ROWS}
      indicator={<TimelineWorkingIndicator isThinking={isThinking} />}
      showIndicator={visible}
    />
  );
}

// ---------------------------------------------------------------------------

export function Rows() {
  const [flickerKey, setFlickerKey] = useState(0);
  const [flickerPaused, setFlickerPaused] = useState(true);
  const [conversationKey, setConversationKey] = useState(0);
  const [conversationPaused, setConversationPaused] = useState(true);
  const [indicatorKey, setIndicatorKey] = useState(0);
  const [indicatorPaused, setIndicatorPaused] = useState(true);
  const [bundleKey, setBundleKey] = useState(0);
  const [bundlePaused, setBundlePaused] = useState(true);
  const [assistantStreamingKey, setAssistantStreamingKey] = useState(0);
  const [assistantStreamingPaused, setAssistantStreamingPaused] =
    useState(true);

  return (
    <StoryCard>
      <StoryRow
        label={
          <StreamingLabel
            title="optimistic user message flicker"
            hint="optimistic user row mounts, then is replaced by the server row with a different id but identical content"
            onRestart={() => setFlickerKey((k) => k + 1)}
            isPaused={flickerPaused}
            onTogglePause={() => setFlickerPaused((p) => !p)}
          />
        }
      >
        <OptimisticUserMessageFlicker
          restartKey={flickerKey}
          isPaused={flickerPaused}
        />
      </StoryRow>
      <StoryRow
        label={
          <StreamingLabel
            title="working / thinking indicator"
            hint="indicator toggles in and out, alternating Working... and Thinking..."
            onRestart={() => setIndicatorKey((k) => k + 1)}
            isPaused={indicatorPaused}
            onTogglePause={() => setIndicatorPaused((p) => !p)}
          />
        }
      >
        <WorkingIndicatorToggling
          restartKey={indicatorKey}
          isPaused={indicatorPaused}
        />
      </StoryRow>
      <StoryRow
        label={
          <StreamingLabel
            title="assistant messages"
            hint="user / assistant rows mount one at a time at the bottom"
            onRestart={() => setConversationKey((k) => k + 1)}
            isPaused={conversationPaused}
            onTogglePause={() => setConversationPaused((p) => !p)}
          />
        }
      >
        <ConversationRowsArriving
          restartKey={conversationKey}
          isPaused={conversationPaused}
        />
      </StoryRow>
      <StoryRow
        label={
          <StreamingLabel
            title="assistant content streaming"
            hint="one assistant row mounts, then its markdown body grows sentence by sentence"
            onRestart={() => setAssistantStreamingKey((k) => k + 1)}
            isPaused={assistantStreamingPaused}
            onTogglePause={() => setAssistantStreamingPaused((p) => !p)}
          />
        }
      >
        <AssistantContentStreaming
          restartKey={assistantStreamingKey}
          isPaused={assistantStreamingPaused}
        />
      </StoryRow>
      <StoryRow
        label={
          <StreamingLabel
            title="bundle children"
            hint="Read / Grep / Glob rows append into the trailing exploration bundle"
            onRestart={() => setBundleKey((k) => k + 1)}
            isPaused={bundlePaused}
            onTogglePause={() => setBundlePaused((p) => !p)}
          />
        }
      >
        <BundleChildrenArriving
          restartKey={bundleKey}
          isPaused={bundlePaused}
        />
      </StoryRow>
    </StoryCard>
  );
}
