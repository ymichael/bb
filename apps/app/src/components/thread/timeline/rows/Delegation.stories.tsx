import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Delegation",
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
// Real delegation rows pulled from `~/.bb-dev/bb.db`, thread
// `thr_cfpiech9ui` ("Final review provider turn-id fixes"). The thread
// dispatched three real Agent subagents (subagent_type = "Explore") in
// parallel to review a commit range:
//
//   1. toolu_01LKp2KK7kaTCi5vi15VZYvw — Correctness review (14 toolCalls,
//      4 commandExecutions)
//   2. toolu_012rpTKMPCmiRnZnYXLA5Vy9 — Maintainability and AGENTS.md
//      compliance review (12 toolCalls, 10 commandExecutions)
//   3. toolu_01VfaFeGbfjGckpp9LZNpd5a — Test quality review (19 toolCalls,
//      3 commandExecutions)
//
// Each child row's command/toolArgs/output/path comes from the events DB.
// Output strings are truncated to 300 chars with a "... [truncated]" suffix.
//
// Lifecycle coverage note: all three dispatches actually completed
// successfully. The running/error/interrupted variants below re-use real
// dispatches with the *status* (and completedAt/output) synthesized so we
// can render the non-completed lifecycle states; their childRows are real.
// Regenerate via /tmp/build-delegation-fixtures.mjs.
// ---------------------------------------------------------------------------

const THREAD_ID = "thr_cfpiech9ui";
const TURN_ID = "turn_21b66e2a4c034b96_1";


// =============================================================================
// Dispatch 1 — toolu_01LKp2KK7kaTCi5vi15VZYvw, "Correctness review of commit range".
// Real Agent dispatch with 14 toolCall children (Read/Grep/Glob) and 4
// commandExecution children. The agent's full report is truncated to ~3KB;
// each child output is truncated to 300 chars.
// =============================================================================

const correctnessChild01: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01TpyeWMqu4G5aCbShDsiv4X",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 51,
  "sourceSeqEnd": 52,
  "startedAt": 1778174307803,
  "createdAt": 1778174307803,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01TpyeWMqu4G5aCbShDsiv4X",
  "command": "git diff 97aa16934..e547e8106 --stat",
  "cwd": null,
  "source": null,
  "output": " apps/host-daemon/src/app.ts                        |   7 +\n apps/host-daemon/test/helpers/test-server.ts       |  48 ++++++-\n .../test/integration/daemon.integration.test.ts    |  77 ++++++++++\n .../internal/internal-events-tool-calls.test.ts    |  52 +++++++\n .../agent-runtime/src/claude-code/brid... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174307803,
  "approvalStatus": null,
  "activityIntents": [],
};

const correctnessChild02: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01TcFvrJ5Z7xswQsbA8DwuiS",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 53,
  "sourceSeqEnd": 54,
  "startedAt": 1778174307811,
  "createdAt": 1778174307811,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01TcFvrJ5Z7xswQsbA8DwuiS",
  "command": "git diff 97aa16934..e547e8106 -- packages/agent-runtime/src/runtime-provider-requests.ts packages/agent-runtime/src/shared/provider-tool-call-contract.ts packages/domain/src/provider-types.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/packages/agent-runtime/src/runtime-provider-requests.ts b/packages/agent-runtime/src/runtime-provider-requests.ts\nindex f87f709b6..88e53530f 100644\n--- a/packages/agent-runtime/src/runtime-provider-requests.ts\n+++ b/packages/agent-runtime/src/runtime-provider-requests.ts\n@@ -47,6 +47,7 ... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174307811,
  "approvalStatus": null,
  "activityIntents": [],
};

const correctnessChild03: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01XfjG4aRkJFecL7GnEc3vLH",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 55,
  "sourceSeqEnd": 56,
  "startedAt": 1778174307811,
  "createdAt": 1778174307811,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01XfjG4aRkJFecL7GnEc3vLH",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "limit": 150,
  },
  "output": "1\timport type { ChildProcess } from \"node:child_process\";\n2\timport type {\n3\t  AgentRuntimeExecutionOptions,\n4\t  AgentRuntimeOptions,\n5\t} from \"./types.js\";\n6\timport type {\n7\t  PendingInteractionCreate,\n8\t  PendingInteractionPayload,\n9\t  PendingInteractionResolution,\n10\t  ToolCallRequest,\n11\t} from \"... [truncated]",
  "completedAt": 1778174307811,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const correctnessChild04: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_015zVQkMM47412gCpawWXUEP",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 57,
  "sourceSeqEnd": 58,
  "startedAt": 1778174307811,
  "createdAt": 1778174307811,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_015zVQkMM47412gCpawWXUEP",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.ts",
  },
  "output": "1\timport { z } from \"zod\";\n2\timport type { DecodedToolCallRequest } from \"../provider-adapter.js\";\n3\t\n4\tconst normalizedToolCallRequestSchema = z.object({\n5\t  providerThreadId: z.string().min(1),\n6\t  threadId: z.string().min(1).optional(),\n7\t  // Canonical bridge wire form: required string when know... [truncated]",
  "completedAt": 1778174307811,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-tool-call-contract.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.ts",
    },
  ],
};

const correctnessChild05: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_019jw4CN4WEd6ERQZEgRN7Pm",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 59,
  "sourceSeqEnd": 60,
  "startedAt": 1778174307811,
  "createdAt": 1778174307811,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_019jw4CN4WEd6ERQZEgRN7Pm",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/domain/src/provider-types.ts",
    "limit": 100,
  },
  "output": "1\timport { z } from \"zod\";\n2\timport { permissionModeSchema, reasoningLevelSchema } from \"./shared-types.js\";\n3\t\n4\texport const modelReasoningEffortSchema = z.object({\n5\t  reasoningEffort: reasoningLevelSchema,\n6\t  description: z.string(),\n7\t});\n8\texport type ModelReasoningEffort = z.infer<typeof mod... [truncated]",
  "completedAt": 1778174307811,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-types.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/domain/src/provider-types.ts",
    },
  ],
};

const correctnessChild06: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01Mr1LjyreTqTD3nHzDxWmHB",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 61,
  "sourceSeqEnd": 62,
  "startedAt": 1778174307811,
  "createdAt": 1778174307811,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "toolu_01Mr1LjyreTqTD3nHzDxWmHB",
  "command": "grep -r \"getActiveTurnId\" --include=\"*.ts\" packages/agent-runtime/src/",
  "cwd": null,
  "source": null,
  "output": "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.",
  "exitCode": 1,
  "completedAt": 1778174307811,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "grep -r \"getActiveTurnId\" --include=\"*.ts\" packages/agent-runtime/src/",
      "query": "getActiveTurnId",
      "path": "packages/agent-runtime/src/",
    },
  ],
};

const correctnessChild07: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01FrXbRuAHubcQSJfSP5xYAx",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 63,
  "sourceSeqEnd": 64,
  "startedAt": 1778174307811,
  "createdAt": 1778174307811,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01FrXbRuAHubcQSJfSP5xYAx",
  "toolName": "Grep",
  "toolArgs": {
    "pattern": "getActiveTurnId",
    "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
    "output_mode": "content",
  },
  "output": "packages/agent-runtime/src/runtime.tool-calls.test.ts:201:        getActiveTurnId: () => undefined,\npackages/agent-runtime/src/runtime-turn-state.ts:15:  getActiveTurnId(threadId: string): string | undefined {\npackages/agent-runtime/src/runtime-turn-state.test.ts:31:    expect(state.getActiveTurnId(... [truncated]",
  "completedAt": 1778174307811,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "Grep",
      "query": "getActiveTurnId",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
    },
  ],
};

const correctnessChild08: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01RzyDhxnqDW48wDAib6jNKg",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 65,
  "sourceSeqEnd": 66,
  "startedAt": 1778174307811,
  "createdAt": 1778174307849,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01RzyDhxnqDW48wDAib6jNKg",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.ts",
    "limit": 200,
  },
  "output": "1\timport type { DynamicTool, InstructionMode, ThreadEvent } from \"@bb/domain\";\n2\timport type { AgentRuntimeCaptureEntry } from \"./capture-types.js\";\n3\timport type {\n4\t  AdapterCommand,\n5\t  ProviderAdapterFactory,\n6\t  ProviderCommandPlan,\n7\t  ProviderRequestCommandPlan,\n8\t} from \"./provider-adapter.j... [truncated]",
  "completedAt": 1778174307849,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.ts",
    },
  ],
};

const correctnessChild09: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01R1yNfRG8iq6y6VFhZV5vuk",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 68,
  "sourceSeqEnd": 69,
  "startedAt": 1778174320113,
  "createdAt": 1778174320113,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01R1yNfRG8iq6y6VFhZV5vuk",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-turn-state.ts",
  },
  "output": "1\timport type { ThreadEvent } from \"@bb/domain\";\n2\timport { requireThreadEventScopeTurnId } from \"@bb/domain\";\n3\t\n4\texport class RuntimeTurnState {\n5\t  private readonly activeTurnIdByThreadId = new Map<string, string>();\n6\t\n7\t  clear(): void {\n8\t    this.activeTurnIdByThreadId.clear();\n9\t  }\n10\t\n11\t... [truncated]",
  "completedAt": 1778174320113,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-turn-state.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-turn-state.ts",
    },
  ],
};

const correctnessChild10: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01MzvBB9Xz6AYAUDuHK9ei9v",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 70,
  "sourceSeqEnd": 71,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01MzvBB9Xz6AYAUDuHK9ei9v",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    "offset": 195,
    "limit": 100,
  },
  "output": "195\t    } satisfies JsonRpcMessage;\n196\t\n197\t    try {\n198\t      handleRuntimeProviderRequest({\n199\t        createCaptureId: () => \"cap-1\",\n200\t        emitCapture: (entry) => captures.push(entry),\n201\t        getActiveTurnId: () => undefined,\n202\t        getThreadExecutionOptions: () => undefined,\n... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.tool-calls.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    },
  ],
};

const correctnessChild11: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_016CvX8aof8TvLnJQAHzm9Kp",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 72,
  "sourceSeqEnd": 73,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "toolu_016CvX8aof8TvLnJQAHzm9Kp",
  "command": "git diff 97aa16934..e547e8106 -- packages/agent-runtime/src/shared/provider-tool-call-contract.ts | grep -A 5 -B 5 \"normalizeDecodedTurnId\"",
  "cwd": null,
  "source": null,
  "output": "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.",
  "exitCode": 1,
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "git diff 97aa16934..e547e8106 -- packages/agent-runtime/src/shared/provider-tool-call-contract.ts | grep -A 5 -B 5 \"normalizeDecodedTurnId\"",
      "query": "normalizeDecodedTurnId",
      "path": null,
    },
  ],
};

const correctnessChild12: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01TG4xEfDo7RCyJd5znxaxBU",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 74,
  "sourceSeqEnd": 75,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01TG4xEfDo7RCyJd5znxaxBU",
  "toolName": "Grep",
  "toolArgs": {
    "pattern": "without a turn id",
    "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
    "output_mode": "content",
    "context": 5,
  },
  "output": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts-223-      expect(parsed.parsed).toMatchObject({\npackages/agent-runtime/src/runtime.tool-calls.test.ts-224-        jsonrpc: \"2.0\",\npackages/agent-runtime/src/runtime.tool-calls.test.ts-225-       ... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "Grep",
      "query": "without a turn id",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
    },
  ],
};

const correctnessChild13: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01MXGm4YpNuPruFS8ypKHpgJ",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 76,
  "sourceSeqEnd": 77,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01MXGm4YpNuPruFS8ypKHpgJ",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 147,
    "limit": 80,
  },
  "output": "147\t  const resolvedTurnId = resolveRuntimeProviderRequestTurnId({\n148\t    ...args,\n149\t    requestKind: \"tool call\",\n150\t    resolvedThreadId,\n151\t    turnId: toolCallReq.turnId,\n152\t  });\n153\t  if (resolvedTurnId === null) {\n154\t    return true;\n155\t  }\n156\t\n157\t  const scopedToolCallReq: ToolCall... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const correctnessChild14: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_011nVJrg2Fu5oQhZCPraot5z",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 78,
  "sourceSeqEnd": 79,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "error",
  "callId": "toolu_011nVJrg2Fu5oQhZCPraot5z",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": "[88, 111]",
  },
  "output": "<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe parameter `offset` type is expected as `number` but provided as `string`</tool_use_error>",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const correctnessChild15: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01RT7BtsquuXF1nZgsoAVpTh",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 97,
  "sourceSeqEnd": 98,
  "startedAt": 1778174321398,
  "createdAt": 1778174321398,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01RT7BtsquuXF1nZgsoAVpTh",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 88,
    "limit": 25,
  },
  "output": "88\tfunction normalizeProviderRequestTurnId(turnId: string | null): string | null {\n89\t  return turnId && turnId.length > 0 ? turnId : null;\n90\t}\n91\t\n92\tfunction resolveRuntimeProviderRequestTurnId(\n93\t  args: ResolveRuntimeProviderRequestTurnIdArgs,\n94\t): string | null {\n95\t  const explicitTurnId = ... [truncated]",
  "completedAt": 1778174321398,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const correctnessChild16: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01Xh9vSHvDVNbbya5BwTNJnq",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 101,
  "sourceSeqEnd": 102,
  "startedAt": 1778174322765,
  "createdAt": 1778174322765,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01Xh9vSHvDVNbbya5BwTNJnq",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 260,
    "limit": 60,
  },
  "output": "260\t  }\n261\t  const buildInteractiveResponse =\n262\t    args.providerProcess.adapter.buildInteractiveResponse;\n263\t  const resolvedTurnId = resolveRuntimeProviderRequestTurnId({\n264\t    ...args,\n265\t    requestKind: \"interactive request\",\n266\t    resolvedThreadId,\n267\t    turnId: interactiveReq.turnI... [truncated]",
  "completedAt": 1778174322765,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const correctnessChild17: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_01Pwrk89FbvmiHknCqNte62x",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 104,
  "sourceSeqEnd": 105,
  "startedAt": 1778174324388,
  "createdAt": 1778174324388,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01Pwrk89FbvmiHknCqNte62x",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/CODE_REVIEW.md",
  },
  "output": "1\t# Code Review Checklist\n2\t\n3\tThis document defines the dimensions of a thorough code review. Each section is designed to be evaluated independently — reviewers may delegate sections to separate agents working in parallel.\n4\t\n5\t## Unbiased Review Protocol\n6\t\n7\tA code review must be unbiased. Do not... [truncated]",
  "completedAt": 1778174324388,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "CODE_REVIEW.md",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/CODE_REVIEW.md",
    },
  ],
};

const correctnessChild18: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw:child:toolu_017GFMs55ESo9nU3A2fAqP94",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 113,
  "sourceSeqEnd": 114,
  "startedAt": 1778174326400,
  "createdAt": 1778174326400,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_017GFMs55ESo9nU3A2fAqP94",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.test.ts",
  },
  "output": "1\timport { describe, expect, it } from \"vitest\";\n2\timport {\n3\t  decodeNativeProviderToolCallRequest,\n4\t  decodeNormalizedProviderToolCallRequest,\n5\t} from \"./provider-tool-call-contract.js\";\n6\t\n7\tdescribe(\"provider-tool-call-contract\", () => {\n8\t  it(\"preserves optional BB thread hints on normalized... [truncated]",
  "completedAt": 1778174326400,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-tool-call-contract.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.test.ts",
    },
  ],
};
const completedDelegation: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 50,
  "sourceSeqEnd": 161,
  "startedAt": 1778174295406,
  "createdAt": 1778174341060,
  "kind": "work",
  "workKind": "delegation",
  "status": "completed",
  "callId": "toolu_01LKp2KK7kaTCi5vi15VZYvw",
  "toolName": "Agent",
  "subagentType": "Explore",
  "description": "Correctness review of commit range",
  "output": "Perfect! Now let me review the full context of the change to complete my analysis:\n\nBased on my thorough review of commit range 97aa16934..e547e8106, here are my findings on **Correctness and Shortcuts/Workarounds**:\n\n## CRITICAL FINDINGS\n\n**1. No-op normalization function (Definite smell)**\n- **File**: packages/agent-runtime/src/shared/provider-tool-call-contract.ts:41-43\n- **Code**: \n  ```typescript\n  function normalizeDecodedTurnId(turnId: string | null): string | null {\n    return turnId;\n  }\n  ```\n- **Issue**: This function does nothing—it returns the input unchanged. The schema already validates `turnId: z.union([z.string().min(1), z.null()])`, so the input cannot be empty string or undefined. The function exists but serves no purpose and creates misleading API surface suggesting normalization happens.\n- **Verdict**: Dead code, increases confusion.\n\n**2. Empty string handling gap (Definite bug)**\n- **File**: packages/agent-runtime/src/runtime-provider-requests.ts:88-90\n- **Code**:\n  ```typescript\n  function normalizeProviderRequestTurnId(turnId: string | null): string | null {\n    return turnId && turnId.length > 0 ? turnId : null;\n  }\n  ```\n- **Issue**: The schema in provider-tool-call-contract.ts rejects empty strings (`z.string().min(1)`), yet runtime-provider-requests.ts's normalizer tries to handle them. Either:\n  - Empty strings slip past schema validation (broken contract), or\n  - The normalizer is defensive against a risk that validation already eliminated\n  - This inconsistency suggests the schema change (adding `.min(1)`) wasn't coordinated with the normalizer design\n- **Verdict**: Questionable—suggests incomplete refactoring or defensive layering.\n\n**3. Repair workaround masks earlier loss of turn context (Architectural issue)**\n- **Files**: runtime-provider-requests.ts:92-111, runtime-turn-state.ts\n- **Logic**: The new `resolveRuntimeProviderRequestTurnId()` accepts null turnIds and falls back to `getActiveTurnId()` to fill gaps. If both fail, it sends an error to the provider.\n- **Root cause**: Providers can emit `turnId: null` when they don't know the turn ID themselves. Rather than fixing this at the source (require providers to always resolve turns before emitting, or enhance the wire protocol to make turn context mandatory), the code patches it here.\n- **Verdict**: **This is a workaround for a deeper protocol issue**. The fix works but postpones fixing the data model. If providers shouldn't emit unresolved turns, enforce that upstream in schema validation. If they legitimately can't, the protocol needs redesign to make turn ID resolution a first-class concern.\n\n**4. ActiveTurnId state isolation risk (Potential edge case bug)**\n- **File**: runtime-turn-state.ts:15-17, runtime-provider-requests.ts:100-103\n- **Issue**: `RuntimeTurnState.getActiveTurnId()` returns the currently active turn for a thread. The repair logic assumes there's only one \"active\" turn at a time and uses it as fallback. But:\n  - Concurrent tool calls with... [truncated]",
  "completedAt": 1778174341060,  "childRows": [
    correctnessChild01,
    correctnessChild02,
    correctnessChild03,
    correctnessChild04,
    correctnessChild05,
    correctnessChild06,
    correctnessChild07,
    correctnessChild08,
    correctnessChild09,
    correctnessChild10,
    correctnessChild11,
    correctnessChild12,
    correctnessChild13,
    correctnessChild14,
    correctnessChild15,
    correctnessChild16,
    correctnessChild17,
    correctnessChild18,
  ],
};

// =============================================================================
// Dispatch 2 — toolu_012rpTKMPCmiRnZnYXLA5Vy9, "Maintainability and AGENTS.md compliance review".
// SYNTHESIZED STATUS — real dispatch toolu_012rpTKMPCmiRnZnYXLA5Vy9 completed;
// lifecycle synthesized for the running variant. childRows are real.
// startedAt/createdAt use Date.now() so "running for N seconds" stays plausible.
// =============================================================================

const maintainabilityChild01: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_015c6YonUcnAaKbMibXaHsvx",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 99,
  "sourceSeqEnd": 100,
  "startedAt": 1778174322035,
  "createdAt": 1778174322035,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_015c6YonUcnAaKbMibXaHsvx",
  "command": "git diff 97aa16934..e547e8106 --stat",
  "cwd": null,
  "source": null,
  "output": " apps/host-daemon/src/app.ts                        |   7 +\n apps/host-daemon/test/helpers/test-server.ts       |  48 ++++++-\n .../test/integration/daemon.integration.test.ts    |  77 ++++++++++\n .../internal/internal-events-tool-calls.test.ts    |  52 +++++++\n .../agent-runtime/src/claude-code/brid... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174322035,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild02: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01JWtVVgmGTPtFxDyL42Zcse",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 103,
  "sourceSeqEnd": 106,
  "startedAt": 1778174324109,
  "createdAt": 1778174324519,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01JWtVVgmGTPtFxDyL42Zcse",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/domain/src/provider-types.ts",
  },
  "output": "1\timport { z } from \"zod\";\n2\timport { permissionModeSchema, reasoningLevelSchema } from \"./shared-types.js\";\n3\t\n4\texport const modelReasoningEffortSchema = z.object({\n5\t  reasoningEffort: reasoningLevelSchema,\n6\t  description: z.string(),\n7\t});\n8\texport type ModelReasoningEffort = z.infer<typeof mod... [truncated]",
  "completedAt": 1778174324519,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-types.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/domain/src/provider-types.ts",
    },
  ],
};

const maintainabilityChild03: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01FDLgX2tYJnA5v74VkUCZPY",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 107,
  "sourceSeqEnd": 108,
  "startedAt": 1778174324533,
  "createdAt": 1778174324957,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01FDLgX2tYJnA5v74VkUCZPY",
  "command": "git diff 97aa16934..e547e8106 packages/domain/src/provider-types.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/packages/domain/src/provider-types.ts b/packages/domain/src/provider-types.ts\nindex 518740b50..2192d23fa 100644\n--- a/packages/domain/src/provider-types.ts\n+++ b/packages/domain/src/provider-types.ts\n@@ -47,12 +47,12 @@ export const toolCallOutputItemSchema = z.discriminatedUnion(\"type\"... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174324957,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild04: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01TRjfsFujnuK8gYy2hA2S6z",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 109,
  "sourceSeqEnd": 110,
  "startedAt": 1778174325005,
  "createdAt": 1778174325005,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01TRjfsFujnuK8gYy2hA2S6z",
  "command": "git diff 97aa16934..e547e8106 packages/agent-runtime/src/runtime-provider-requests.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/packages/agent-runtime/src/runtime-provider-requests.ts b/packages/agent-runtime/src/runtime-provider-requests.ts\nindex f87f709b6..88e53530f 100644\n--- a/packages/agent-runtime/src/runtime-provider-requests.ts\n+++ b/packages/agent-runtime/src/runtime-provider-requests.ts\n@@ -47,6 +47,7 ... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174325005,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild05: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01Gz64C6FQJZP5pMy2u8rGTa",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 111,
  "sourceSeqEnd": 112,
  "startedAt": 1778174325043,
  "createdAt": 1778174325043,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01Gz64C6FQJZP5pMy2u8rGTa",
  "command": "git diff 97aa16934..e547e8106 packages/agent-runtime/src/shared/provider-tool-call-contract.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/packages/agent-runtime/src/shared/provider-tool-call-contract.ts b/packages/agent-runtime/src/shared/provider-tool-call-contract.ts\nindex b4680250b..251e3f2f9 100644\n--- a/packages/agent-runtime/src/shared/provider-tool-call-contract.ts\n+++ b/packages/agent-runtime/src/shared/provider-t... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174325043,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild06: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01Laa6LAdEEuUho3bFEe4NWw",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 117,
  "sourceSeqEnd": 118,
  "startedAt": 1778174326928,
  "createdAt": 1778174326960,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01Laa6LAdEEuUho3bFEe4NWw",
  "command": "git diff 97aa16934..e547e8106 packages/agent-runtime/src/runtime.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/packages/agent-runtime/src/runtime.ts b/packages/agent-runtime/src/runtime.ts\nindex 7536e95c6..4ea20c221 100644\n--- a/packages/agent-runtime/src/runtime.ts\n+++ b/packages/agent-runtime/src/runtime.ts\n@@ -547,6 +547,7 @@ function createAgentRuntimeInternal(\n       handleRuntimeProviderRe... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174326960,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild07: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_019xtsxgbj33QMijxpDAUJdg",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 119,
  "sourceSeqEnd": 120,
  "startedAt": 1778174327096,
  "createdAt": 1778174327096,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_019xtsxgbj33QMijxpDAUJdg",
  "command": "git diff 97aa16934..e547e8106 packages/agent-runtime/src/provider-adapter.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/packages/agent-runtime/src/provider-adapter.ts b/packages/agent-runtime/src/provider-adapter.ts\nindex 4a63269f6..b8e2b7ddc 100644\n--- a/packages/agent-runtime/src/provider-adapter.ts\n+++ b/packages/agent-runtime/src/provider-adapter.ts\n@@ -69,7 +69,7 @@ export type ProviderInteractiveRe... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174327096,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild08: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01KXspdWg8VQ29yyhyVXgT9w",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 121,
  "sourceSeqEnd": 122,
  "startedAt": 1778174327134,
  "createdAt": 1778174327134,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01KXspdWg8VQ29yyhyVXgT9w",
  "command": "git diff 97aa16934..e547e8106 apps/host-daemon/src/app.ts",
  "cwd": null,
  "source": null,
  "output": "diff --git a/apps/host-daemon/src/app.ts b/apps/host-daemon/src/app.ts\nindex ce9f52897..76bae1dd6 100644\n--- a/apps/host-daemon/src/app.ts\n+++ b/apps/host-daemon/src/app.ts\n@@ -325,6 +325,12 @@ export async function createHostDaemonApp(\n     await eventBuffer.flushRequired();\n   }\n \n+  async functio... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174327134,
  "approvalStatus": null,
  "activityIntents": [],
};

const maintainabilityChild09: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01NJoEUxMguFeAjrnTZwj8GV",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 125,
  "sourceSeqEnd": 126,
  "startedAt": 1778174329343,
  "createdAt": 1778174329343,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "toolu_01NJoEUxMguFeAjrnTZwj8GV",
  "command": "grep -r \"getActiveTurnId\\|activeTurnId\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages --include=\"*.ts\" --include=\"*.tsx\" | grep -v test | grep -v node_modules | head -20",
  "cwd": null,
  "source": null,
  "output": "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.",
  "exitCode": 1,
  "completedAt": 1778174329343,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "grep -r \"getActiveTurnId\\|activeTurnId\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages --include=\"*.ts\" --include=\"*.tsx\" | grep -v test | grep -v node_modules | head -20",
      "query": "getActiveTurnId|activeTurnId",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages",
    },
  ],
};

const maintainabilityChild10: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01Qh9ZSnXFXQz1Mcf9TVKpBP",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 127,
  "sourceSeqEnd": 128,
  "startedAt": 1778174329698,
  "createdAt": 1778174329698,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "toolu_01Qh9ZSnXFXQz1Mcf9TVKpBP",
  "command": "grep -r \"normalizeProviderRequestTurnId\\|resolveTurnId\\|turnId.*null\\|turnId.*undefined\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src --include=\"*.ts\" | grep -v test | head -20",
  "cwd": null,
  "source": null,
  "output": "<tool_use_error>Cancelled: parallel tool call Bash(grep -r \"getActiveTurnId\\|activeTurnId\" …) errored</tool_use_error>",
  "exitCode": 1,
  "completedAt": 1778174329698,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "grep -r \"normalizeProviderRequestTurnId\\|resolveTurnId\\|turnId.*null\\|turnId.*undefined\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src --include=\"*.ts\" | grep -v test | head -20",
      "query": "normalizeProviderRequestTurnId|resolveTurnId|turnId.*null|turnId.*undefined",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
    },
  ],
};

const maintainabilityChild11: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_0137uMvmuTBfBDNC6GTuFegF",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 131,
  "sourceSeqEnd": 132,
  "startedAt": 1778174331549,
  "createdAt": 1778174331743,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_0137uMvmuTBfBDNC6GTuFegF",
  "toolName": "Grep",
  "toolArgs": {
    "pattern": "getActiveTurnId|activeTurnId",
    "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages",
    "type": "ts",
    "output_mode": "files_with_matches",
  },
  "output": "Found 15 files\npackages/agent-runtime/src/runtime.tool-calls.test.ts\npackages/agent-runtime/src/test/fake-adapter.ts\npackages/agent-runtime/src/runtime-provider-requests.ts\npackages/agent-runtime/src/runtime.ts\npackages/agent-runtime/src/provider-adapter.ts\npackages/db/test/data/events.test.ts\npacka... [truncated]",
  "completedAt": 1778174331743,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "Grep",
      "query": "getActiveTurnId|activeTurnId",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages",
    },
  ],
};

const maintainabilityChild12: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01AewZ2V8UKq8x2zGUpmYTJc",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 133,
  "sourceSeqEnd": 134,
  "startedAt": 1778174331956,
  "createdAt": 1778174331956,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01AewZ2V8UKq8x2zGUpmYTJc",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "limit": 120,
  },
  "output": "1\timport type { ChildProcess } from \"node:child_process\";\n2\timport type {\n3\t  AgentRuntimeExecutionOptions,\n4\t  AgentRuntimeOptions,\n5\t} from \"./types.js\";\n6\timport type {\n7\t  PendingInteractionCreate,\n8\t  PendingInteractionPayload,\n9\t  PendingInteractionResolution,\n10\t  ToolCallRequest,\n11\t} from \"... [truncated]",
  "completedAt": 1778174331956,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const maintainabilityChild13: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01RrkCGuMaJRJnq1UEaUhZra",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 135,
  "sourceSeqEnd": 136,
  "startedAt": 1778174332201,
  "createdAt": 1778174332201,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01RrkCGuMaJRJnq1UEaUhZra",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.ts",
  },
  "output": "1\timport { z } from \"zod\";\n2\timport type { DecodedToolCallRequest } from \"../provider-adapter.js\";\n3\t\n4\tconst normalizedToolCallRequestSchema = z.object({\n5\t  providerThreadId: z.string().min(1),\n6\t  threadId: z.string().min(1).optional(),\n7\t  // Canonical bridge wire form: required string when know... [truncated]",
  "completedAt": 1778174332201,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-tool-call-contract.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.ts",
    },
  ],
};

const maintainabilityChild14: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_018jZNMCkMxNfkUUKKTL83jg",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 139,
  "sourceSeqEnd": 140,
  "startedAt": 1778174334394,
  "createdAt": 1778174334659,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_018jZNMCkMxNfkUUKKTL83jg",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-turn-state.ts",
    "limit": 80,
  },
  "output": "1\timport type { ThreadEvent } from \"@bb/domain\";\n2\timport { requireThreadEventScopeTurnId } from \"@bb/domain\";\n3\t\n4\texport class RuntimeTurnState {\n5\t  private readonly activeTurnIdByThreadId = new Map<string, string>();\n6\t\n7\t  clear(): void {\n8\t    this.activeTurnIdByThreadId.clear();\n9\t  }\n10\t\n11\t... [truncated]",
  "completedAt": 1778174334659,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-turn-state.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-turn-state.ts",
    },
  ],
};

const maintainabilityChild15: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01L2NPQTYQ1TPJ3V8BDiEMNM",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 141,
  "sourceSeqEnd": 142,
  "startedAt": 1778174335009,
  "createdAt": 1778174335009,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01L2NPQTYQ1TPJ3V8BDiEMNM",
  "toolName": "Grep",
  "toolArgs": {
    "pattern": "normalizeProviderRequestTurnId|normalizeDecodedTurnId",
    "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages",
    "type": "ts",
    "output_mode": "content",
    "context": 2,
  },
  "output": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts-86-}\n/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts-87-\npackages/agent-runtime/src/runtime-provider-requests.ts:88:function normalize... [truncated]",
  "completedAt": 1778174335009,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "Grep",
      "query": "normalizeProviderRequestTurnId|normalizeDecodedTurnId",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages",
    },
  ],
};

const maintainabilityChild16: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_013HiJs8nJhPy9B8FK1qdvtR",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 147,
  "sourceSeqEnd": 148,
  "startedAt": 1778174337162,
  "createdAt": 1778174337233,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_013HiJs8nJhPy9B8FK1qdvtR",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/CODE_REVIEW.md",
    "limit": 200,
  },
  "output": "1\t# Code Review Checklist\n2\t\n3\tThis document defines the dimensions of a thorough code review. Each section is designed to be evaluated independently — reviewers may delegate sections to separate agents working in parallel.\n4\t\n5\t## Unbiased Review Protocol\n6\t\n7\tA code review must be unbiased. Do not... [truncated]",
  "completedAt": 1778174337233,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "CODE_REVIEW.md",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/CODE_REVIEW.md",
    },
  ],
};

const maintainabilityChild17: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01DiyVs3dWcvgcadf3u5T5TD",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 149,
  "sourceSeqEnd": 150,
  "startedAt": 1778174337304,
  "createdAt": 1778174337304,
  "kind": "work",
  "workKind": "tool",
  "status": "error",
  "callId": "toolu_01DiyVs3dWcvgcadf3u5T5TD",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/AGENTS.md",
    "limit": 150,
  },
  "output": "File does not exist. Note: your current working directory is /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb.",
  "completedAt": 1778174337304,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "AGENTS.md",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/AGENTS.md",
    },
  ],
};

const maintainabilityChild18: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01WgmbhKxwK7GBBxWdZCFwSh",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 151,
  "sourceSeqEnd": 154,
  "startedAt": 1778174338751,
  "createdAt": 1778174339096,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01WgmbhKxwK7GBBxWdZCFwSh",
  "toolName": "Glob",
  "toolArgs": {
    "pattern": "**/AGENTS.md",
  },
  "output": "AGENTS.md",
  "completedAt": 1778174339096,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "list_files",
      "command": "Glob",
      "path": null,
    },
  ],
};

const maintainabilityChild19: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01BKymQzXAXtFPNnCzgo9wgK",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 155,
  "sourceSeqEnd": 156,
  "startedAt": 1778174339267,
  "createdAt": 1778174339267,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01BKymQzXAXtFPNnCzgo9wgK",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    "limit": 100,
    "offset": 0,
  },
  "output": "0\timport { spawn, type ChildProcess } from \"node:child_process\";\n1\timport { mkdtempSync, rmSync } from \"node:fs\";\n2\timport { tmpdir } from \"node:os\";\n3\timport { join } from \"node:path\";\n4\timport { afterEach, beforeEach, describe, expect, it, vi } from \"vitest\";\n5\timport type { ThreadEvent, ToolCallR... [truncated]",
  "completedAt": 1778174339267,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.tool-calls.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    },
  ],
};

const maintainabilityChild20: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01LdKey3EgtP3UvJSKba7xZD",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 157,
  "sourceSeqEnd": 159,
  "startedAt": 1778174340928,
  "createdAt": 1778174340928,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01LdKey3EgtP3UvJSKba7xZD",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/AGENTS.md",
    "limit": 250,
  },
  "output": "1\t# Codebase Guidelines\n2\t\n3\t## Type Safety\n4\t\n5\t- No `unknown`, no `as X` casts unless the type is genuinely unknowable (e.g., freeform tool input). Our boundaries validate and parse; everything inside the system is strongly typed.\n6\t- Never inline types in function signatures. Define them in the a... [truncated]",
  "completedAt": 1778174340928,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "AGENTS.md",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/AGENTS.md",
    },
  ],
};

const maintainabilityChild21: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01TVs6USWf18cG7TjeeCZePk",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 164,
  "sourceSeqEnd": 165,
  "startedAt": 1778174343133,
  "createdAt": 1778174343741,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01TVs6USWf18cG7TjeeCZePk",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/provider-adapter.ts",
    "limit": 100,
  },
  "output": "1\timport type {\n2\t  AvailableModel,\n3\t  ClientTurnRequestId,\n4\t  DynamicTool,\n5\t  InstructionMode,\n6\t  PendingInteractionPayload,\n7\t  PendingInteractionResolution,\n8\t  PromptInput,\n9\t  ProviderCapabilities,\n10\t  ReasoningLevel,\n11\t  RuntimePermissionPolicy,\n12\t  ServiceTier,\n13\t  ThreadEvent,\n14\t} f... [truncated]",
  "completedAt": 1778174343741,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-adapter.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/provider-adapter.ts",
    },
  ],
};

const maintainabilityChild22: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9:child:toolu_01VobbeuPdbWkxhbn1t6dS9V",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 166,
  "sourceSeqEnd": 167,
  "startedAt": 1778174343811,
  "createdAt": 1778174343811,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "toolu_01VobbeuPdbWkxhbn1t6dS9V",
  "command": "grep -n \"normalizeDecodedTurnId\\|normalizeProviderRequestTurnId\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.ts /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
  "cwd": null,
  "source": null,
  "output": "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.",
  "exitCode": 1,
  "completedAt": 1778174343811,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "grep -n \"normalizeDecodedTurnId\\|normalizeProviderRequestTurnId\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.ts /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
      "query": "normalizeDecodedTurnId|normalizeProviderRequestTurnId",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};
const runningDelegation: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_012rpTKMPCmiRnZnYXLA5Vy9",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 94,
  "sourceSeqEnd": 178,
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "kind": "work",
  "workKind": "delegation",
  "status": "pending",
  "callId": "toolu_012rpTKMPCmiRnZnYXLA5Vy9",
  "toolName": "Agent",
  "subagentType": "Explore",
  "description": "Maintainability and AGENTS.md compliance review",
  "output": "",
  "completedAt": null,  "childRows": [
    maintainabilityChild01,
    maintainabilityChild02,
    maintainabilityChild03,
    maintainabilityChild04,
    maintainabilityChild05,
    maintainabilityChild06,
    maintainabilityChild07,
    maintainabilityChild08,
    maintainabilityChild09,
    maintainabilityChild10,
    maintainabilityChild11,
    maintainabilityChild12,
    maintainabilityChild13,
    maintainabilityChild14,
    maintainabilityChild15,
    maintainabilityChild16,
    maintainabilityChild17,
    maintainabilityChild18,
    maintainabilityChild19,
    maintainabilityChild20,
    maintainabilityChild21,
    maintainabilityChild22,
  ],
};

// =============================================================================
// Dispatch 3 — toolu_01VfaFeGbfjGckpp9LZNpd5a, "Test quality review of commit range".
// SYNTHESIZED STATUS — real dispatch toolu_01VfaFeGbfjGckpp9LZNpd5a completed;
// lifecycle synthesized for the error variant. childRows are real.
// =============================================================================

const testQualityChild01: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_019aG3TWUimWvWRahTUNouZT",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 80,
  "sourceSeqEnd": 81,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_019aG3TWUimWvWRahTUNouZT",
  "command": "git log --oneline 97aa16934..e547e8106",
  "cwd": null,
  "source": null,
  "output": "e547e8106 test unresolved tool call turn handling\n609373d17 feat: repair unresolved provider turn ids before tool calls",
  "exitCode": 0,
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [],
};

const testQualityChild02: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01LZYN998xx7gtnoFFca21Bd",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 82,
  "sourceSeqEnd": 83,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "command",
  "status": "completed",
  "callId": "toolu_01LZYN998xx7gtnoFFca21Bd",
  "command": "git diff 97aa16934..e547e8106",
  "cwd": null,
  "source": null,
  "output": "<persisted-output>\nOutput too large (35.1KB). Full output saved to: /Users/michael/.claude/projects/-Users-michael--bb-dev-worktrees-env-stt3jzymfp-bb/84f9bb6d-8a5e-4eba-af26-c530415265b1/tool-results/brm54bnvm.txt\n\nPreview (first 2KB):\ndiff --git a/apps/host-daemon/src/app.ts b/apps/host-daemon/src... [truncated]",
  "exitCode": 0,
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [],
};

const testQualityChild03: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_017R2qfR7Ew5FtjAkHxindVG",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 84,
  "sourceSeqEnd": 85,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_017R2qfR7Ew5FtjAkHxindVG",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.claude/projects/-Users-michael--bb-dev-worktrees-env-stt3jzymfp-bb/84f9bb6d-8a5e-4eba-af26-c530415265b1/tool-results/brm54bnvm.txt",
  },
  "output": "1\tdiff --git a/apps/host-daemon/src/app.ts b/apps/host-daemon/src/app.ts\n2\tindex ce9f52897..76bae1dd6 100644\n3\t--- a/apps/host-daemon/src/app.ts\n4\t+++ b/apps/host-daemon/src/app.ts\n5\t@@ -325,6 +325,12 @@ export async function createHostDaemonApp(\n6\t     await eventBuffer.flushRequired();\n7\t   }\n8\t \n... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "brm54bnvm.txt",
      "path": "/Users/michael/.claude/projects/-Users-michael--bb-dev-worktrees-env-stt3jzymfp-bb/84f9bb6d-8a5e-4eba-af26-c530415265b1/tool-results/brm54bnvm.txt",
    },
  ],
};

const testQualityChild04: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_0126Lp4nhkfV2L27g1WRVDTK",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 86,
  "sourceSeqEnd": 87,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_0126Lp4nhkfV2L27g1WRVDTK",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 356,
    "limit": 50,
  },
  "output": "356\t  void args\n357\t    .onInteractiveRequest(scopedInteractiveReq)\n358\t    .then((resolution) => {\n359\t      args.emitCapture({\n360\t        kind: \"interactive-result\",\n361\t        capturedAt: Date.now(),\n362\t        providerId,\n363\t        requestCaptureId: captureId,\n364\t        requestId: scopedI... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const testQualityChild05: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01S9M2AYPpp49BXjbJK1HP8s",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 88,
  "sourceSeqEnd": 89,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01S9M2AYPpp49BXjbJK1HP8s",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 356,
    "limit": 30,
  },
  "output": "356\t  void args\n357\t    .onInteractiveRequest(scopedInteractiveReq)\n358\t    .then((resolution) => {\n359\t      args.emitCapture({\n360\t        kind: \"interactive-result\",\n361\t        capturedAt: Date.now(),\n362\t        providerId,\n363\t        requestCaptureId: captureId,\n364\t        requestId: scopedI... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const testQualityChild06: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01RsbcAF3JqweDSdRyYwAgLr",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 90,
  "sourceSeqEnd": 91,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "command",
  "status": "error",
  "callId": "toolu_01RsbcAF3JqweDSdRyYwAgLr",
  "command": "grep -n \"function resolveRuntimeProviderRequestTurnId\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts -A 25",
  "cwd": null,
  "source": null,
  "output": "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.",
  "exitCode": 1,
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "grep -n \"function resolveRuntimeProviderRequestTurnId\" /Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts -A 25",
      "query": "function resolveRuntimeProviderRequestTurnId",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const testQualityChild07: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01Eiv3DJQp4wX5Sxm1iygUzs",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 92,
  "sourceSeqEnd": 93,
  "startedAt": 1778174320120,
  "createdAt": 1778174320120,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01Eiv3DJQp4wX5Sxm1iygUzs",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 360,
    "limit": 30,
  },
  "output": "360\t        kind: \"interactive-result\",\n361\t        capturedAt: Date.now(),\n362\t        providerId,\n363\t        requestCaptureId: captureId,\n364\t        requestId: scopedInteractiveReq.providerRequestId,\n365\t        success: true,\n366\t        resolution,\n367\t      });\n368\t      const result = buildI... [truncated]",
  "completedAt": 1778174320120,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const testQualityChild08: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01MCxco7vLc7G3hF7ZiGD4qw",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 95,
  "sourceSeqEnd": 96,
  "startedAt": 1778174321234,
  "createdAt": 1778174321234,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01MCxco7vLc7G3hF7ZiGD4qw",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "offset": 1,
    "limit": 450,
  },
  "output": "1\timport type { ChildProcess } from \"node:child_process\";\n2\timport type {\n3\t  AgentRuntimeExecutionOptions,\n4\t  AgentRuntimeOptions,\n5\t} from \"./types.js\";\n6\timport type {\n7\t  PendingInteractionCreate,\n8\t  PendingInteractionPayload,\n9\t  PendingInteractionResolution,\n10\t  ToolCallRequest,\n11\t} from \"... [truncated]",
  "completedAt": 1778174321234,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime-provider-requests.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const testQualityChild09: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01JchQ7TkFdQdGrBRWSbncWT",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 115,
  "sourceSeqEnd": 116,
  "startedAt": 1778174326775,
  "createdAt": 1778174326775,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01JchQ7TkFdQdGrBRWSbncWT",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    "offset": 546,
    "limit": 100,
  },
  "output": "<system-reminder>Warning: the file exists but is shorter than the provided offset (546). The file has 432 lines.</system-reminder>",
  "completedAt": 1778174326775,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.tool-calls.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    },
  ],
};

const testQualityChild10: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01E2asMizztDz5CyN14dMhpN",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 123,
  "sourceSeqEnd": 124,
  "startedAt": 1778174328806,
  "createdAt": 1778174328806,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01E2asMizztDz5CyN14dMhpN",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
  },
  "output": "1\timport { spawn, type ChildProcess } from \"node:child_process\";\n2\timport { mkdtempSync, rmSync } from \"node:fs\";\n3\timport { tmpdir } from \"node:os\";\n4\timport { join } from \"node:path\";\n5\timport { afterEach, beforeEach, describe, expect, it, vi } from \"vitest\";\n6\timport type { ThreadEvent, ToolCallR... [truncated]",
  "completedAt": 1778174328806,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.tool-calls.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.tool-calls.test.ts",
    },
  ],
};

const testQualityChild11: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01J4gkAxEfdC64X11afYxem8",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 129,
  "sourceSeqEnd": 130,
  "startedAt": 1778174330819,
  "createdAt": 1778174330819,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01J4gkAxEfdC64X11afYxem8",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.test.ts",
  },
  "output": "1\timport { describe, expect, it } from \"vitest\";\n2\timport {\n3\t  decodeNativeProviderToolCallRequest,\n4\t  decodeNormalizedProviderToolCallRequest,\n5\t} from \"./provider-tool-call-contract.js\";\n6\t\n7\tdescribe(\"provider-tool-call-contract\", () => {\n8\t  it(\"preserves optional BB thread hints on normalized... [truncated]",
  "completedAt": 1778174330819,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "provider-tool-call-contract.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/shared/provider-tool-call-contract.test.ts",
    },
  ],
};

const testQualityChild12: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_014pEj9Xye9WvvNVqGmvkmqu",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 137,
  "sourceSeqEnd": 138,
  "startedAt": 1778174333366,
  "createdAt": 1778174333366,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_014pEj9Xye9WvvNVqGmvkmqu",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/server/test/internal/internal-events-tool-calls.test.ts",
    "offset": 534,
    "limit": 100,
  },
  "output": "534\t    }\n535\t  });\n536\t\n537\t  it(\"rejects empty tool call turn ids at the internal contract boundary\", async () => {\n538\t    const harness = await createTestAppHarness();\n539\t    try {\n540\t      const { host, session } = seedHostSession(harness.deps);\n541\t      const { project } = seedProjectWithSo... [truncated]",
  "completedAt": 1778174333366,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "internal-events-tool-calls.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/server/test/internal/internal-events-tool-calls.test.ts",
    },
  ],
};

const testQualityChild13: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01SKjRPqYQFmCEzaGSh6FfJa",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 143,
  "sourceSeqEnd": 144,
  "startedAt": 1778174335699,
  "createdAt": 1778174335699,
  "kind": "work",
  "workKind": "tool",
  "status": "error",
  "callId": "toolu_01SKjRPqYQFmCEzaGSh6FfJa",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/host-daemon/test/integration/daemon.integration.test.ts",
    "offset": "[135, 210]",
    "limit": 100,
  },
  "output": "<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe parameter `offset` type is expected as `number` but provided as `string`</tool_use_error>",
  "completedAt": 1778174335699,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "daemon.integration.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/host-daemon/test/integration/daemon.integration.test.ts",
    },
  ],
};

const testQualityChild14: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01C7q5NApoZD4cMZ7RRFHHDw",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 145,
  "sourceSeqEnd": 146,
  "startedAt": 1778174336890,
  "createdAt": 1778174336890,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01C7q5NApoZD4cMZ7RRFHHDw",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/host-daemon/test/integration/daemon.integration.test.ts",
    "offset": 135,
    "limit": 100,
  },
  "output": "135\t        parsed.success &&\n136\t        parsed.data.threadId === args.threadId &&\n137\t        parsed.data.type === args.eventType\n138\t      );\n139\t    });\n140\t  } catch (error) {\n141\t    if (error instanceof Error && error.message.includes(\"no such table\")) {\n142\t      return false;\n143\t    }\n144\t... [truncated]",
  "completedAt": 1778174336890,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "daemon.integration.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/host-daemon/test/integration/daemon.integration.test.ts",
    },
  ],
};

const testQualityChild15: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01ArcrJfbandowa85ykUZhcq",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 152,
  "sourceSeqEnd": 153,
  "startedAt": 1778174339071,
  "createdAt": 1778174339071,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01ArcrJfbandowa85ykUZhcq",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/host-daemon/test/integration/daemon.integration.test.ts",
    "offset": 1000,
    "limit": 150,
  },
  "output": "1000\t      try {\n1001\t        harness.server.queueCommand({\n1002\t          ...createStandardThreadStartCommand({\n1003\t            environmentId: \"env-a\",\n1004\t            threadId: \"thread-a\",\n1005\t            workspacePath: harness.envAPath,\n1006\t            projectId: \"project-1\",\n1007\t           ... [truncated]",
  "completedAt": 1778174339071,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "daemon.integration.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/apps/host-daemon/test/integration/daemon.integration.test.ts",
    },
  ],
};

const testQualityChild16: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01HkrwxKJMBAw7578K5uBkMz",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 158,
  "sourceSeqEnd": 160,
  "startedAt": 1778174340928,
  "createdAt": 1778174340950,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01HkrwxKJMBAw7578K5uBkMz",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/tests/integration/fake/smoke/tool-calls.test.ts",
  },
  "output": "1\timport { getThreadEventScopeTurnId } from \"@bb/domain\";\n2\timport { describe, expect, it } from \"vitest\";\n3\timport { getThreadEvents, sendTextMessage } from \"../../helpers/api.js\";\n4\timport {\n5\t  waitForEventType,\n6\t  waitForThreadStatus,\n7\t} from \"../../helpers/assertions.js\";\n8\timport { withHarne... [truncated]",
  "completedAt": 1778174340950,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "tool-calls.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/tests/integration/fake/smoke/tool-calls.test.ts",
    },
  ],
};

const testQualityChild17: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01Dr58Ys2UuPG5exzsGw6spz",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 162,
  "sourceSeqEnd": 163,
  "startedAt": 1778174342822,
  "createdAt": 1778174342822,
  "kind": "work",
  "workKind": "tool",
  "status": "error",
  "callId": "toolu_01Dr58Ys2UuPG5exzsGw6spz",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.interactive-requests.test.ts",
    "offset": "[130, 210]",
    "limit": 100,
  },
  "output": "<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe parameter `offset` type is expected as `number` but provided as `string`</tool_use_error>",
  "completedAt": 1778174342822,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.interactive-requests.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.interactive-requests.test.ts",
    },
  ],
};

const testQualityChild18: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01K5G3ZkQ3niia6HV2kf3t2p",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 168,
  "sourceSeqEnd": 169,
  "startedAt": 1778174344194,
  "createdAt": 1778174344194,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01K5G3ZkQ3niia6HV2kf3t2p",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.interactive-requests.test.ts",
    "offset": 130,
    "limit": 100,
  },
  "output": "130\t      \"utf8\",\n131\t    );\n132\t\n133\t    const requests: Array<{\n134\t      threadId: string;\n135\t      providerThreadId: string;\n136\t      turnId: string;\n137\t    }> = [];\n138\t    const events: ThreadEvent[] = [];\n139\t    const runtime = createAgentRuntimeWithAdapters({\n140\t      workspacePath: tmp... [truncated]",
  "completedAt": 1778174344194,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "runtime.interactive-requests.test.ts",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime.interactive-requests.test.ts",
    },
  ],
};

const testQualityChild19: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01AjtqHb4fLvVQYx48h6NkMb",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 170,
  "sourceSeqEnd": 171,
  "startedAt": 1778174346469,
  "createdAt": 1778174346469,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01AjtqHb4fLvVQYx48h6NkMb",
  "toolName": "Grep",
  "toolArgs": {
    "pattern": "resolveThreadId.*null|resolveThreadId.*return.*false",
    "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
  },
  "output": "No files found",
  "completedAt": 1778174346469,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "Grep",
      "query": "resolveThreadId.*null|resolveThreadId.*return.*false",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src",
    },
  ],
};

const testQualityChild20: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_017wGU2FfUB77iS9G9E4LL6P",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 172,
  "sourceSeqEnd": 173,
  "startedAt": 1778174348304,
  "createdAt": 1778174348304,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_017wGU2FfUB77iS9G9E4LL6P",
  "toolName": "Grep",
  "toolArgs": {
    "pattern": "normalizeProviderRequestTurnId|getActiveTurnId|sendJsonRpcError",
    "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    "output_mode": "content",
  },
  "output": "17:  sendJsonRpcError,\n50:  getActiveTurnId: (threadId: string) => string | undefined;\n88:function normalizeProviderRequestTurnId(turnId: string | null): string | null {\n95:  const explicitTurnId = normalizeProviderRequestTurnId(args.turnId);\n100:  const activeTurnId = args.getActiveTurnId(args.reso... [truncated]",
  "completedAt": 1778174348304,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "search",
      "command": "Grep",
      "query": "normalizeProviderRequestTurnId|getActiveTurnId|sendJsonRpcError",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/packages/agent-runtime/src/runtime-provider-requests.ts",
    },
  ],
};

const testQualityChild21: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01TEYARUSSsvYkRn3edf2a1g",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 174,
  "sourceSeqEnd": 175,
  "startedAt": 1778174349615,
  "createdAt": 1778174349701,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01TEYARUSSsvYkRn3edf2a1g",
  "toolName": "Glob",
  "toolArgs": {
    "pattern": "CODE_REVIEW.md",
  },
  "output": "docs/CODE_REVIEW.md",
  "completedAt": 1778174349701,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "list_files",
      "command": "Glob",
      "path": null,
    },
  ],
};

const testQualityChild22: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a:child:toolu_01T4hVAKKBqVzJ9kHS9pc93G",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 176,
  "sourceSeqEnd": 177,
  "startedAt": 1778174351117,
  "createdAt": 1778174351117,
  "kind": "work",
  "workKind": "tool",
  "status": "completed",
  "callId": "toolu_01T4hVAKKBqVzJ9kHS9pc93G",
  "toolName": "Read",
  "toolArgs": {
    "file_path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/CODE_REVIEW.md",
    "offset": 1,
    "limit": 150,
  },
  "output": "1\t# Code Review Checklist\n2\t\n3\tThis document defines the dimensions of a thorough code review. Each section is designed to be evaluated independently — reviewers may delegate sections to separate agents working in parallel.\n4\t\n5\t## Unbiased Review Protocol\n6\t\n7\tA code review must be unbiased. Do not... [truncated]",
  "completedAt": 1778174351117,
  "approvalStatus": null,
  "activityIntents": [
    {
      "type": "read",
      "command": "Read",
      "name": "CODE_REVIEW.md",
      "path": "/Users/michael/.bb-dev/worktrees/env_stt3jzymfp/bb/docs/CODE_REVIEW.md",
    },
  ],
};
const errorDelegation: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01VfaFeGbfjGckpp9LZNpd5a",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 67,
  "sourceSeqEnd": 179,
  "startedAt": 1778174308003,
  "createdAt": 1778174370069,
  "kind": "work",
  "workKind": "delegation",
  "status": "error",
  "callId": "toolu_01VfaFeGbfjGckpp9LZNpd5a",
  "toolName": "Agent",
  "subagentType": "Explore",
  "description": "Test quality review of commit range",
  "output": "",
  "completedAt": 1778174370069,  "childRows": [
    testQualityChild01,
    testQualityChild02,
    testQualityChild03,
    testQualityChild04,
    testQualityChild05,
    testQualityChild06,
    testQualityChild07,
    testQualityChild08,
    testQualityChild09,
    testQualityChild10,
    testQualityChild11,
    testQualityChild12,
    testQualityChild13,
    testQualityChild14,
    testQualityChild15,
    testQualityChild16,
    testQualityChild17,
    testQualityChild18,
    testQualityChild19,
    testQualityChild20,
    testQualityChild21,
    testQualityChild22,
  ],
};

// =============================================================================
// Interrupted variant — re-uses Dispatch 1 (correctness review,
// toolu_01LKp2KK7kaTCi5vi15VZYvw) with status synthesized as "interrupted"
// and empty output. childRows are the same real rows as the completed
// variant; this is intentional — see header note. The id suffix
// "-interrupted" keeps the synthesized row distinct from the completed one.
// =============================================================================

const interruptedDelegation: TimelineRow = {
  "id": "thr_cfpiech9ui:delegation:toolu_01LKp2KK7kaTCi5vi15VZYvw-interrupted",
  "threadId": "thr_cfpiech9ui",
  "turnId": "turn_21b66e2a4c034b96_1",
  "sourceSeqStart": 50,
  "sourceSeqEnd": 161,
  "startedAt": 1778174295406,
  "createdAt": 1778174341060,
  "kind": "work",
  "workKind": "delegation",
  "status": "interrupted",
  "callId": "toolu_01LKp2KK7kaTCi5vi15VZYvw-interrupted",
  "toolName": "Agent",
  "subagentType": "Explore",
  "description": "Correctness review of commit range",
  "output": "",
  "completedAt": 1778174341060,  "childRows": [
    correctnessChild01,
    correctnessChild02,
    correctnessChild03,
    correctnessChild04,
    correctnessChild05,
    correctnessChild06,
    correctnessChild07,
    correctnessChild08,
    correctnessChild09,
    correctnessChild10,
    correctnessChild11,
    correctnessChild12,
    correctnessChild13,
    correctnessChild14,
    correctnessChild15,
    correctnessChild16,
    correctnessChild17,
    correctnessChild18,
  ],
};


export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="completed"
        hint="real correctness-review subagent dispatch (14 tool calls + 4 commands), expanded by default to show real childRows"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([completedDelegation.id])}
            timelineRows={[completedDelegation]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="running"
        hint="maintainability + AGENTS.md compliance review (real dispatch, status synthesized as pending)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[runningDelegation]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="error"
        hint="test quality review (real dispatch, status synthesized as error; childRows are real)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[errorDelegation]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="interrupted"
        hint="re-uses the correctness-review dispatch with status synthesized as interrupted; childRows are real"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedDelegation]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
