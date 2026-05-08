import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Command",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  threadRuntimeDisplayStatus: "idle" as const,
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
};

// ---------------------------------------------------------------------------
// Real command rows pulled from a live thread in ~/.bb-dev/bb.db
// (thr_zeb7z9afmw — "Refactor projection / package boundary"). These are
// non-parsed-intent commands (pnpm exec turbo run *, git status) — the kind
// the agent runs that don't get classified as read/list_files/search.
// Outputs are truncated to ~3KB so the story stays manageable.
// ---------------------------------------------------------------------------

const lintCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_sad2tEhg7JbBkt36PDVPgAbL",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36144,
  "sourceSeqEnd": 36149,
  "startedAt": 1777337400300,
  "createdAt": 1777337400998,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "call_sad2tEhg7JbBkt36PDVPgAbL",
  "command": "pnpm exec turbo run lint --filter=@bb/core-ui --filter=@bb/server --concurrency=1",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": "• turbo 2.8.3\n• Packages in scope: @bb/core-ui, @bb/server\n• Running lint in 2 packages\n• Remote caching disabled, using shared worktree cache\n\nNo tasks were executed as part of this run.\n\n Tasks:    0 successful, 0 total\nCached:    0 cached, 0 total\n  Time:    90ms \n\n",
  "exitCode": 0,
  "completedAt": 1777337400998,
  "approvalStatus": null,
  "activityIntents": []
};

const buildCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_bdPhraVkSWcMs5kt1qRviLwZ",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36459,
  "sourceSeqEnd": 36521,
  "startedAt": 1777337519841,
  "createdAt": 1777337521831,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "call_bdPhraVkSWcMs5kt1qRviLwZ",
  "command": "pnpm exec turbo run build --filter=@bb/server --concurrency=1",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": "\u2022 turbo 2.8.3\n\u2022 Packages in scope: @bb/server\n\u2022 Running build in 1 packages\n\u2022 Remote caching disabled, using shared worktree cache\n@bb/process-utils:build: cache hit, replaying logs 9de11a586fe39bfe\n@bb/process-utils:build: \n@bb/process-utils:build: > @bb/process-utils@0.0.1 build /Users/michael/.codex/worktrees/d914/bb/packages/process-utils\n@bb/process-utils:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@bb/process-utils:build: \n@bb/domain:build: cache hit, replaying logs 103774c8ba3d56bc\n@bb/domain:build: \n@bb/domain:build: > @bb/domain@0.0.1 build /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/domain\n@bb/domain:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@bb/domain:build: \n@bb/sandbox-image:build: cache hit, replaying logs ce1ed8341c645fb1\n@bb/sandbox-image:build: \n@bb/sandbox-image:build: > @bb/sandbox-image@0.0.1 build /Users/michael/.codex/worktrees/d914/bb/packages/sandbox-image\n@bb/sandbox-image:build: > tsc\n@bb/sandbox-image:build: \n@bb/templates:build: cache hit, replaying logs 5f5da67cbdf705f2\n@bb/templates:build: \n@bb/templates:build: > @bb/templates@0.0.1 build /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/templates\n@bb/templates:build: > node ./scripts/generate-templates.mjs && esbuild src/index.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/index.js --sourcemap && tsc --project tsconfig.json --emitDeclarationOnly --declaration --declarationMap --outDir dist\n@bb/templates:build: \n@bb/templates:build: \n@bb/templates:build:   dist/index.js      270.5kb\n@bb/templates:build:   dist/index.js.map  439.4kb\n@bb/templates:build: \n@bb/templates:build: \u26a1 Done in 10ms\n@bb/secret-storage:build: cache hit, replaying logs 8b137f6300ba5864\n@bb/secret-storage:build: \n@bb/secret-storage:build: > @bb/secret-storage@0.0.1 build /Users/michael/.codex/worktrees/d914/bb/packages/secret-storage\n@bb/secret-storage:build: > rm -rf dist tsconfig.tsbuildinfo && tsc\n@bb/secret-storage:build: \n@bb/hono-typed-routes:build: cache hit, replaying logs 9c8ab6ce7d3ea2eb\n@bb/hono-typed-routes:build: \n@bb/hono-typed-routes:build: > @bb/hono-typed-routes@0.0.1 build /Users/michael/.codex/worktrees/d914/bb/packages/hono-typed-routes\n@bb/hono-typed-routes:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@bb/hono-typed-routes:build: \n@bb/config:build: cache hit, replaying logs 0ef37fe60164e4b6\n@bb/config:build: \n@bb/config:build: > @bb/config@0.0.1 build /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/config\n@bb/config:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@bb/config:build: \n@bb/test-helpers:build: cache hit, replaying logs dc291cedace4ce6c\n@bb/test-helpers:build: \n@bb/test-helpers:build: > @bb/test-helpers@0.0.1 build /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/test-helpers\n@bb/test-helpers:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@bb/test-helpers:build: \n@bb/db:build: cache hit, replaying logs 2e667adc5220280f\n@bb/db:build: \n@bb/db:build: > @bb/db@0.0.1 build /Users\n... [truncated for fixture]",
  "exitCode": 0,
  "completedAt": 1777337521831,
  "approvalStatus": null,
  "activityIntents": []
};

const failedTestCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_YP1N5ZE2JWN5lUQhSCRbDiqU",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36242,
  "sourceSeqEnd": 36392,
  "startedAt": 1777337478063,
  "createdAt": 1777337485182,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "call_YP1N5ZE2JWN5lUQhSCRbDiqU",
  "command": "pnpm exec turbo run test --filter=@bb/core-ui --filter=@bb/server --only --concurrency=1",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": "\u2022 turbo 2.8.3\n\u2022 Packages in scope: @bb/core-ui, @bb/server\n\u2022 Running test in 2 packages\n\u2022 Remote caching disabled, using shared worktree cache\n@bb/server:test: cache miss, executing 38ec9ac79a329473\n@bb/server:test: \n@bb/server:test: > @bb/server@0.0.1 test /Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/apps/server\n@bb/server:test: > vitest run --config vitest.config.ts\n@bb/server:test: \n@bb/server:test: \n@bb/server:test: \u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.1 \u001b[39m\u001b[90m/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/apps/server\u001b[39m\n@bb/server:test: \n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-thread-interactions.test.ts \u001b[2m(\u001b[22m\u001b[2m11 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 347\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-cloud-auth.test.ts \u001b[2m(\u001b[22m\u001b[2m11 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 328\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-automations.test.ts \u001b[2m(\u001b[22m\u001b[2m12 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 373\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/hosts/host-lifecycle.test.ts \u001b[2m(\u001b[22m\u001b[2m16 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 451\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/internal/internal-command-result-idempotency.test.ts \u001b[2m(\u001b[22m\u001b[2m16 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 451\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/internal/internal-event-side-effects.test.ts \u001b[2m(\u001b[22m\u001b[2m16 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 508\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/system/periodic-sweeps.test.ts \u001b[2m(\u001b[22m\u001b[2m22 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 595\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-thread-lifecycle-regressions.test.ts \u001b[2m(\u001b[22m\u001b[2m12 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 580\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/services/pending-interactions.test.ts \u001b[2m(\u001b[22m\u001b[2m15 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 510\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-projects-hosts.test.ts \u001b[2m(\u001b[22m\u001b[2m23 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 654\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-threads.sandbox-host.test.ts \u001b[2m(\u001b[22m\u001b[2m21 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 653\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-environments-system.test.ts \u001b[2m(\u001b[22m\u001b[2m24 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 814\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/internal/internal-session.test.ts \u001b[2m(\u001b[22m\u001b[2m33 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 968\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\u001b[39m test/public/public-thread-data.test.ts \u001b[2m(\u001b[22m\u001b[2m27 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 979\u001b[2mms\u001b[22m\u001b[39m\n@bb/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @bb/server \u001b[49m\n... [truncated for fixture]",
  "exitCode": 1,
  "completedAt": 1777337485182,
  "approvalStatus": null,
  "activityIntents": []
};

// Real interrupted command from thr_gnkq5q3vnt — `pnpm ladle` was killed by
// the agent's controlling timeout (exit -1 = interrupted). The output ends
// mid-stream with a SIGTERM rejection from pnpm.
const interruptedCommand: TimelineRow = {
  "id": "thr_gnkq5q3vnt:command:call_ladle_interrupted",
  "threadId": "thr_gnkq5q3vnt",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 0,
  "sourceSeqEnd": 0,
  "startedAt": 1777337000000,
  "createdAt": 1777337000000,
  "kind": "work",
  "workKind": "command",
  "status": "interrupted",
  "callId": "call_ladle_interrupted",
  "command": "pnpm --filter @bb/app ladle -- --host 127.0.0.1 --port 6167",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_ec5gx8y7mm/bb",
  "source": null,
  "output": "   ╭────────────────────────────────────────────────────╮\n   │                                                    │\n   │   🥄 Ladle.dev served at http://localhost:61000/   │\n   │                                                    │\n   ╰────────────────────────────────────────────────────╯\n\n8:12:55 PM [vite] (client) ✨ new dependencies optimized: axe-core, msw/browser\n8:12:55 PM [vite] (client) ✨ optimized dependencies changed. reloading\n\n  Error: read ECONNRESET\n      at TCP.onStreamRead (node:internal/stream_base_commons:216:20)\n\n/Users/michael/.bb-dev/worktrees/env_ec5gx8y7mm/bb/apps/app:\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @bb/app@0.0.1 ladle: `ladle serve \"--\" \"--host\" \"127.0.0.1\" \"--port\" \"6167\"`\nCommand failed with signal \"SIGTERM\"\n",
  "exitCode": -1,
  "completedAt": 1777337010000,
  "approvalStatus": null,
  "activityIntents": []
};

// Running command — status=pending, no exitCode/completedAt yet. Realistic
// long-running test-watch command: the agent kicked off vitest and the row
// is mid-flight.
const runningCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_running",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36500,
  "sourceSeqEnd": 36500,
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "kind": "work",
  "workKind": "command",
  "status": "pending",
  "callId": "call_running",
  "command": "pnpm exec turbo run test --filter=@bb/server",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": "",
  "exitCode": null,
  "completedAt": null,
  "approvalStatus": null,
  "activityIntents": []
};

// Waiting for approval — destructive-looking command parked on the approval
// gate. status=pending, approvalStatus=waiting_for_approval.
const waitingApprovalCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_waiting_approval",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36600,
  "sourceSeqEnd": 36600,
  "startedAt": 1777337700000,
  "createdAt": 1777337700000,
  "kind": "work",
  "workKind": "command",
  "status": "pending",
  "callId": "call_waiting_approval",
  "command": "git push --force-with-lease origin main",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": "",
  "exitCode": null,
  "completedAt": null,
  "approvalStatus": "waiting_for_approval",
  "activityIntents": []
};

const gitStatusCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_mGiBdXdFLpyTGMucYCnI82LR",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 35830,
  "sourceSeqEnd": 35831,
  "startedAt": 1777337321939,
  "createdAt": 1777337321939,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "call_mGiBdXdFLpyTGMucYCnI82LR",
  "command": "git status --short",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": " M apps/server/src/services/threads/timeline.ts\n D packages/core-ui/src/active-thinking.ts\n M packages/core-ui/src/assistant-stream-projection.ts\n M packages/core-ui/src/index.ts\n M packages/core-ui/src/to-view-messages.ts\n",
  "exitCode": 0,
  "completedAt": 1777337321939,
  "approvalStatus": null,
  "activityIntents": []
};

// Denied — user rejected the approval request, command never ran.
const deniedCommand: TimelineRow = {
  "id": "thr_zeb7z9afmw:command:call_denied",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36700,
  "sourceSeqEnd": 36700,
  "startedAt": 1777337800000,
  "createdAt": 1777337800000,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "call_denied",
  "command": "rm -rf node_modules",
  "cwd": "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  "source": null,
  "output": "",
  "exitCode": null,
  "completedAt": 1777337805000,
  "approvalStatus": "denied",
  "activityIntents": []
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed — completed"
        hint="production-default — header only, click to expand"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[buildCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — running"
        hint="status=pending, no exit code yet, output streaming"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[runningCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — error"
        hint="status=error, exit 1"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[failedTestCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — interrupted"
        hint="killed by controlling timeout (SIGTERM, exit -1)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — waiting for approval"
        hint="approvalStatus=waiting_for_approval, parked before execution"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[waitingApprovalCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — denied"
        hint="approvalStatus=denied, user rejected the approval request"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[deniedCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="git status" hint="short clean output, exit 0">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([gitStatusCommand.id])}
            timelineRows={[gitStatusCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="lint"
        hint="pnpm exec turbo run lint — short output, completed"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([lintCommand.id])}
            timelineRows={[lintCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="build"
        hint="pnpm exec turbo run build — longer output scrolls inside the row"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([buildCommand.id])}
            timelineRows={[buildCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="failed test"
        hint="pnpm exec turbo run test — status=error, exit 1, real failure output"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([failedTestCommand.id])}
            timelineRows={[failedTestCommand]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
