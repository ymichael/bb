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
  threadRuntimeDisplayStatus: "active" as const,
  workspaceRootPath: undefined,
};

const THREAD_ID = "thr_streaming_rows";

function PinnedTimelineStage({
  rows,
  indicator,
  showIndicator,
  cycle = 0,
}: {
  rows: readonly TimelineRow[];
  indicator: ReactNode;
  showIndicator: boolean;
  cycle?: number;
}) {
  return (
    <div
      className="flex h-[360px] w-full max-w-[760px] flex-col rounded-md border border-border bg-background"
      style={{ overflowAnchor: "none" }}
    >
      <PageShell
        scrollBehavior="bottom-anchor"
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-2 pt-4"
        maxWidthClassName="max-w-none"
      >
        <ConversationTimeline className="flex-1">
          <ThreadTimelineRows
            key={`cycle-${cycle}`}
            {...baseProps}
            timelineRows={rows.slice()}
          />
          <HeightTransition visible={showIndicator}>
            {indicator}
          </HeightTransition>
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
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    text: OPTIMISTIC_USER_PROMPT_TEXT,
    mentions: [],
    attachments: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
  };
}

function OptimisticUserMessageFlicker({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
  const { step, cycle } = useStreamingTickLoop(
    2,
    200,
    18,
    restartKey,
    isPaused,
  );
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
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      mentions: [],
      turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
    };
  }
  return {
    ...base,
    role: "assistant",
    turnRequest: null,
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

const ASSISTANT_STREAMING_USER_PROMPT: ConversationStep = {
  role: "user",
  text: "Trace how a command failure surfaces in the timeline — what files are involved?",
};

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
    initiator: "user",
    mentions: [],
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    text: ASSISTANT_STREAMING_USER_PROMPT.text,
    attachments: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
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
    turnRequest: null,
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

interface ExplorationStep {
  callId: string;
  intent:
    | { type: "read"; path: string }
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
    intent: {
      type: "read",
      path: "apps/server/src/services/commands/failure-tracker.ts",
    },
  },
  {
    callId: "bundle_grep_command_failure",
    intent: {
      type: "search",
      query: "command_failure",
      path: "apps/server/src",
    },
  },
  {
    callId: "bundle_read_recoverable",
    intent: {
      type: "read",
      path: "apps/server/src/services/commands/recoverable.ts",
    },
  },
  {
    callId: "bundle_glob_retry_tests",
    intent: { type: "list_files", path: "apps/server/test/commands" },
  },
  {
    callId: "bundle_grep_command_failure_exhausted",
    intent: {
      type: "search",
      query: "command_failure_exhausted",
      path: "packages/thread-view/src",
    },
  },
  {
    callId: "bundle_read_system_row",
    intent: {
      type: "read",
      path: "packages/thread-view/src/system-row.ts",
    },
  },
  {
    callId: "bundle_grep_surface_message",
    intent: {
      type: "search",
      query: "surfaceMessage",
      path: "apps/server/src",
    },
  },
  {
    callId: "bundle_read_retry_policy",
    intent: {
      type: "read",
      path: "apps/server/src/services/commands/retry.ts",
    },
  },
  {
    callId: "bundle_glob_failure_renderers",
    intent: {
      type: "list_files",
      path: "apps/app/src/components/thread",
    },
  },
  {
    callId: "bundle_grep_retry_chip",
    intent: {
      type: "search",
      query: "retry count chip",
      path: "apps/app/src",
    },
  },
  {
    callId: "bundle_read_failure_badge",
    intent: {
      type: "read",
      path: "apps/app/src/components/thread/FailureBadge.tsx",
    },
  },
  {
    callId: "bundle_grep_classifier",
    intent: {
      type: "search",
      query: "classifier",
      path: "apps/server/src/services",
    },
  },
  {
    callId: "bundle_read_telemetry_sink",
    intent: {
      type: "read",
      path: "apps/server/src/services/observability/sink.ts",
    },
  },
  {
    callId: "bundle_grep_emit_failure",
    intent: {
      type: "search",
      query: "emitFailure",
      path: "apps/server/src",
    },
  },
  {
    callId: "bundle_glob_failure_fixtures",
    intent: {
      type: "list_files",
      path: "apps/server/test/fixtures/command-failures",
    },
  },
  {
    callId: "bundle_read_thread_view_system_row",
    intent: {
      type: "read",
      path: "packages/thread-view/src/system-row-renderer.ts",
    },
  },
  {
    callId: "bundle_grep_failure_badge",
    intent: {
      type: "search",
      query: "FailureBadge",
      path: "apps/app/src",
    },
  },
  {
    callId: "bundle_read_failure_badge_test",
    intent: {
      type: "read",
      path: "apps/app/src/components/thread/FailureBadge.test.tsx",
    },
  },
  {
    callId: "bundle_glob_retry_renderers",
    intent: {
      type: "list_files",
      path: "apps/app/src/components/thread",
    },
  },
];

function bundleExplorationRow(step: ExplorationStep, seq: number): TimelineRow {
  const base = {
    id: `streaming-rows-bundle:${step.callId}`,
    threadId: THREAD_ID,
    turnId: "streaming-rows-bundle-turn",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: seq,
    createdAt: seq,
    kind: "work" as const,
    status: "completed" as const,
    callId: step.callId,
    cmd: null,
    completedAt: seq,
  };
  switch (step.intent.type) {
    case "read":
      return { ...base, workKind: "file-read", path: step.intent.path };
    case "search":
      return {
        ...base,
        workKind: "search",
        mode: "content",
        query: step.intent.query,
        path: step.intent.path,
      };
    case "list_files":
      return {
        ...base,
        workKind: "search",
        mode: "list",
        query: "",
        path: step.intent.path,
      };
  }
}

function BundleChildrenArriving({
  restartKey,
  isPaused,
}: {
  restartKey: number;
  isPaused: boolean;
}) {
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
