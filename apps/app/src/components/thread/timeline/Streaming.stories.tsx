import { useEffect, useState } from "react";
import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/Streaming",
};

const baseProps = {
  threadRuntimeDisplayStatus: "active" as const,
  workspaceRootPath: undefined,
};

const THREAD_ID = "thr_streaming";
const TURN_ID = "019dd185-ef12-7d50-aa48-47882e9c8aaf";

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="min-h-[360px] w-full max-w-[760px]">{children}</div>;
}

function StreamingLabel({
  title,
  hint,
  onRestart,
}: {
  title: string;
  hint: string;
  onRestart: () => void;
}) {
  return (
    <span className="flex flex-col items-start gap-2">
      <span className="text-sm text-muted-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
      <button
        type="button"
        onClick={onRestart}
        className="rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground hover:bg-accent"
      >
        Restart
      </button>
    </span>
  );
}

function useStreamingTick(
  totalSteps: number,
  intervalMs: number,
  restartKey: number,
): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
    if (totalSteps === 0) return;
    const id = window.setInterval(() => {
      setStep((current) => {
        if (current >= totalSteps) {
          window.clearInterval(id);
          return current;
        }
        return current + 1;
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [totalSteps, intervalMs, restartKey]);
  return step;
}

const PROVISIONING_LINES: readonly string[] = [
  "Creating worktree (305ms)",
  "HEAD is now at 37eeec85 Refactor timeline row titles",
  "Preparing worktree (new branch 'bb/investigate-thread-timeline-load')",
  "Created worktree (305ms)",
  "Using workspace: /Users/michael/.bb-dev/worktrees/env_etyr7f84cg/bb",
  "Running .bb-env-setup.sh",
  "[bb-env-setup] Running: pnpm install",
  "Scope: all 35 workspace projects",
  "Lockfile is up to date, resolution step is skipped",
  "Progress: resolved 1094, reused 1093, downloaded 0, added 877",
  "Progress: resolved 1094, reused 1094, downloaded 0, added 901",
  "Progress: resolved 1094, reused 1094, downloaded 0, added 920",
  "Progress: resolved 1094, reused 1094, downloaded 0, added 945",
  ".../node_modules/esbuild postinstall$ node install.js",
  ".../node_modules/esbuild postinstall: Done",
  ".../packages/db migrations: applied 0027_quick_warpath.sql",
  ".../packages/db migrations: applied 0028_strange_omega.sql",
  ".../packages/db migrations: applied 0029_acoustic_havok.sql",
  "[bb-env-setup] Running: pnpm exec turbo run build --filter='./packages/*'",
  "@bb/process-utils:build: cache hit, replaying logs",
  "@bb/domain:build: cache hit, replaying logs",
  "@bb/templates:build: cache hit, replaying logs",
  "@bb/secret-storage:build: cache hit, replaying logs",
  "@bb/hono-typed-routes:build: cache hit, replaying logs",
  "@bb/config:build: cache hit, replaying logs",
  "@bb/test-helpers:build: cache hit, replaying logs",
  "@bb/db:build: cache hit, replaying logs",
  "@bb/server-contract:build: cache hit, replaying logs",
  "@bb/host-daemon-contract:build: cache hit, replaying logs",
  "@bb/thread-view:build: cache hit, replaying logs",
  "Tasks: 12 successful, 12 total",
  "Cached: 12 cached, 12 total",
  "Time: 612ms (FULL TURBO)",
  ".bb-env-setup.sh finished (8.2s)",
  "Using branch: bb/investigate-thread-timeline-load (37eeec8)",
  "Provisioned thread (8.7s)",
];

function ProvisioningStreaming({ restartKey }: { restartKey: number }) {
  const step = useStreamingTick(PROVISIONING_LINES.length, 200, restartKey);
  const completed = step >= PROVISIONING_LINES.length;
  const detail = PROVISIONING_LINES.slice(0, step).join("\n");
  const row: TimelineRow = {
    id: "streaming-provisioning",
    threadId: THREAD_ID,
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 0,
    createdAt: 0,
    kind: "system",
    systemKind: "operation",
    operationKind: "thread-provisioning",
    title: completed ? "Provisioned thread" : "Provisioning thread",
    detail: detail.length > 0 ? detail : null,
    status: completed ? "completed" : "pending",
    completedAt: completed ? 0 : null,
  };
  return (
    <TimelineStage>
      <ThreadTimelineRows
        {...baseProps}
        initialExpanded={new Set([row.id])}
        timelineRows={[row]}
      />
    </TimelineStage>
  );
}

const COMMAND_OUTPUT_CHUNKS: readonly string[] = [
  "• turbo 2.8.3\n",
  "• Packages in scope: @bb/server, @bb/core-ui, @bb/domain, @bb/thread-view, @bb/server-contract, @bb/host-daemon-contract\n",
  "• Running test in 6 packages\n",
  "• Remote caching disabled, using shared worktree cache\n",
  "@bb/server:test: cache miss, executing 38ec9ac79a329473\n",
  "@bb/server:test: > @bb/server@0.0.1 test /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/apps/server\n",
  "@bb/server:test: > vitest run --config vitest.config.ts\n",
  "@bb/server:test:  RUN  v4.1.1 /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/apps/server\n",
  "@bb/server:test:  ✓ test/public/public-thread-interactions.test.ts (11 tests) 347ms\n",
  "@bb/server:test:  ✓ test/public/public-thread-data.test.ts (27 tests) 328ms\n",
  "@bb/server:test:  ✓ test/public/public-thread-lifecycle-regressions.test.ts (12 tests) 373ms\n",
  "@bb/server:test:  ✓ test/host-join-enroll.test.ts (16 tests) 451ms\n",
  "@bb/server:test:  ✓ test/internal/internal-command-result-idempotency.test.ts (16 tests) 451ms\n",
  "@bb/server:test:  ✓ test/internal/internal-event-side-effects.test.ts (16 tests) 508ms\n",
  "@bb/server:test:  ✓ test/services/pending-interactions.test.ts (4 tests) 595ms\n",
  "@bb/server:test:  ✓ test/public/public-thread-lifecycle-regressions.test.ts (12 tests) 580ms\n",
  "@bb/server:test:  ✓ test/services/pending-interactions.test.ts (15 tests) 510ms\n",
  "@bb/server:test:  ✓ test/public/public-projects-hosts.test.ts (23 tests) 654ms\n",
  "@bb/server:test:  ✓ test/public/public-threads.environments.test.ts (21 tests) 653ms\n",
  "@bb/server:test:  ✓ test/public/public-environments-system.test.ts (24 tests) 814ms\n",
  "@bb/server:test:  ✓ test/internal/internal-session-correctness.test.ts (33 tests) 968ms\n",
  "@bb/server:test:  ✓ test/public/public-thread-data.test.ts (27 tests) 979ms\n",
  "@bb/server:test:  ✓ test/public/public-threads.steer.test.ts (18 tests) 712ms\n",
  "@bb/server:test:  ✓ test/public/public-threads.send-and-steer.test.ts (24 tests) 1023ms\n",
  "@bb/server:test:  ✓ test/threads/timeline-service.test.ts (52 tests) 1442ms\n",
  "@bb/server:test:\n",
  "@bb/server:test:  Test Files  66 passed (66)\n",
  "@bb/server:test:       Tests  687 passed (687)\n",
  "@bb/server:test:    Start at  21:54:38\n",
  "@bb/server:test:    Duration  16.49s (transform 4.93s, setup 1.21s, collect 0ms, tests 14.21s)\n",
  "\n",
  " Tasks:    6 successful, 6 total\n",
  "Cached:    5 cached, 6 total\n",
  "  Time:    18.231s\n",
];

function RunningCommandStreaming({ restartKey }: { restartKey: number }) {
  const step = useStreamingTick(COMMAND_OUTPUT_CHUNKS.length, 150, restartKey);
  const completed = step >= COMMAND_OUTPUT_CHUNKS.length;
  const output = COMMAND_OUTPUT_CHUNKS.slice(0, step).join("");
  const row: TimelineRow = {
    id: "streaming-command",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    sourceSeqStart: 1,
    sourceSeqEnd: step + 1,
    startedAt: 0,
    createdAt: step,
    kind: "work",
    workKind: "command",
    status: completed ? "completed" : "pending",
    callId: "streaming-command",
    command: "pnpm exec turbo run test --filter=@bb/server",
    cwd: null,
    source: null,
    output,
    exitCode: completed ? 0 : null,
    completedAt: completed ? step : null,
    approvalStatus: null,
    activityIntents: [],
  };
  return (
    <TimelineStage>
      <ThreadTimelineRows
        {...baseProps}
        initialExpanded={new Set([row.id])}
        timelineRows={[row]}
      />
    </TimelineStage>
  );
}

interface ExplorationStep {
  callId: string;
  intent:
    | { type: "read"; path: string }
    | { type: "search"; query: string; path: string }
    | { type: "list_files"; path: string };
}

const EXPLORATION_STEPS: readonly ExplorationStep[] = [
  {
    callId: "stream_read_assist",
    intent: {
      type: "read",
      path: "packages/core-ui/src/assistant-stream-projection.ts",
    },
  },
  {
    callId: "stream_read_index",
    intent: {
      type: "read",
      path: "packages/core-ui/src/index.ts",
    },
  },
  {
    callId: "stream_grep_finalized",
    intent: {
      type: "search",
      query: "finalizedReasoningMessageKeys",
      path: "packages/core-ui/src",
    },
  },
  {
    callId: "stream_glob_tests",
    intent: { type: "list_files", path: "packages/core-ui/test" },
  },
  {
    callId: "stream_read_to_view",
    intent: {
      type: "read",
      path: "packages/core-ui/src/to-view-messages.ts",
    },
  },
  {
    callId: "stream_grep_active_thinking",
    intent: {
      type: "search",
      query: "activeThinking",
      path: "packages/core-ui/src",
    },
  },
  {
    callId: "stream_read_timeline_view",
    intent: {
      type: "read",
      path: "packages/thread-view/src/timeline-view.ts",
    },
  },
  {
    callId: "stream_grep_closed_turn_ids",
    intent: {
      type: "search",
      query: "closedTurnIds",
      path: "packages/core-ui/src",
    },
  },
  {
    callId: "stream_read_build_thread_timeline",
    intent: {
      type: "read",
      path: "packages/thread-view/src/build-thread-timeline.ts",
    },
  },
  {
    callId: "stream_glob_thread_view_tests",
    intent: { type: "list_files", path: "packages/thread-view/test" },
  },
  {
    callId: "stream_read_format_timeline_text",
    intent: {
      type: "read",
      path: "packages/thread-view/src/format-timeline-text.ts",
    },
  },
  {
    callId: "stream_grep_open_step",
    intent: {
      type: "search",
      query: "openStep",
      path: "packages/thread-view/src",
    },
  },
  {
    callId: "stream_read_completed_turn_grouping",
    intent: {
      type: "read",
      path: "packages/thread-view/src/completed-turn-grouping.ts",
    },
  },
  {
    callId: "stream_grep_step_summary",
    intent: {
      type: "search",
      query: "step-summary",
      path: "packages/thread-view/src",
    },
  },
];

function exploringRow(step: ExplorationStep, seq: number): TimelineRow {
  const base = {
    id: `streaming-exploring:${step.callId}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
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

function ExploringBundleStreaming({ restartKey }: { restartKey: number }) {
  const step = useStreamingTick(EXPLORATION_STEPS.length, 250, restartKey);
  const rows = EXPLORATION_STEPS.slice(0, step).map((stepData, index) =>
    exploringRow(stepData, index + 1),
  );
  return (
    <TimelineStage>
      <ThreadTimelineRows {...baseProps} timelineRows={rows} />
    </TimelineStage>
  );
}

export function RowDetails() {
  const [provisioningKey, setProvisioningKey] = useState(0);
  const [commandKey, setCommandKey] = useState(0);
  const [exploringKey, setExploringKey] = useState(0);

  return (
    <StoryCard>
      <StoryRow
        label={
          <StreamingLabel
            title="provisioning, cleaned transcript"
            hint="command echo lines are omitted; real git and setup output still streams"
            onRestart={() => setProvisioningKey((k) => k + 1)}
          />
        }
      >
        <ProvisioningStreaming restartKey={provisioningKey} />
      </StoryRow>
      <StoryRow
        label={
          <StreamingLabel
            title="command output"
            hint="pending command output streams in; exit 0 once the final chunk lands"
            onRestart={() => setCommandKey((k) => k + 1)}
          />
        }
      >
        <RunningCommandStreaming restartKey={commandKey} />
      </StoryRow>
      <StoryRow
        label={
          <StreamingLabel
            title="exploring bundle"
            hint="Read / Grep / Glob rows append into the trailing exploration bundle"
            onRestart={() => setExploringKey((k) => k + 1)}
          />
        }
      >
        <ExploringBundleStreaming restartKey={exploringKey} />
      </StoryRow>
    </StoryCard>
  );
}
