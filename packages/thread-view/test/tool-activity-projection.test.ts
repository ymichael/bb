import { describe, expect, it } from "vitest";
import type { EventMeta } from "../src/event-decode.js";
import type {
  CommandExecutionUpdate,
  DelegationExecutionUpdate,
  ExecutionOutputUpdate,
  ToolCallExecutionUpdate,
} from "../src/exec-lifecycle.js";
import type {
  EventProjectionCommandMessage,
  EventProjectionDelegationMessage,
  EventProjectionMessage,
  EventProjectionToolCallMessage,
  EventProjectionToolParsedIntent,
} from "../src/event-projection-types.js";
import {
  createToolActivityState,
  interruptPendingToolActivity,
  onExecBegin,
  onExecEnd,
  onExecOutput,
  type ToolActivityProjectionState,
} from "../src/tool-activity-projection.js";

type CommandStatus = NonNullable<CommandExecutionUpdate["status"]>;

interface CommandUpdateArgs {
  command?: string;
  durationMs?: number | null;
  output?: string;
  parsedIntents?: EventProjectionToolParsedIntent[];
  status: CommandStatus;
}

interface CommandOutputArgs {
  output: string;
}

interface ApplyCommandOutputArgs extends CommandOutputArgs {
  appendOutput: boolean;
  replaceOutput: boolean;
  seq: number;
}

interface ToolCallUpdateArgs {
  output?: string;
  parsedIntents?: EventProjectionToolParsedIntent[];
  status: NonNullable<ToolCallExecutionUpdate["status"]>;
}

interface DelegationUpdateArgs {
  output?: string;
  status: NonNullable<DelegationExecutionUpdate["status"]>;
}

// Tests pin a fixed `nowMs` so pending-duration assertions are deterministic.
// Production paths default to `Date.now()`.
const PROJECTION_NOW_MS = 2_001;

function createProjectionState(): ToolActivityProjectionState {
  return {
    messages: [],
    toolActivity: createToolActivityState({ nowMs: PROJECTION_NOW_MS }),
  };
}

function eventMeta(seq: number): EventMeta {
  return {
    id: `event-${seq}`,
    seq,
    createdAt: seq,
  };
}

function commandUpdate({
  command = "pnpm test",
  durationMs,
  output,
  parsedIntents,
  status,
}: CommandUpdateArgs): CommandExecutionUpdate {
  return {
    kind: "command",
    callId: "command-1",
    command,
    cwd: "/repo",
    status,
    exitCode: status === "error" ? 1 : 0,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(parsedIntents !== undefined ? { parsedIntents } : {}),
  };
}

function toolCallUpdate({
  output,
  parsedIntents,
  status,
}: ToolCallUpdateArgs): ToolCallExecutionUpdate {
  return {
    kind: "tool-call",
    callId: "tool-1",
    toolName: "Read",
    toolArgs: null,
    status,
    ...(output !== undefined ? { output } : {}),
    ...(parsedIntents !== undefined ? { parsedIntents } : {}),
  };
}

function delegationUpdate({
  output,
  status,
}: DelegationUpdateArgs): DelegationExecutionUpdate {
  return {
    kind: "delegation",
    callId: "delegation-1",
    toolName: "Agent",
    subagentType: "reviewer",
    description: "Review implementation",
    status,
    ...(output !== undefined ? { output } : {}),
  };
}

function commandOutput({ output }: CommandOutputArgs): ExecutionOutputUpdate {
  return {
    callId: "command-1",
    output,
    status: "pending",
  };
}

function isCommandMessage(
  message: EventProjectionMessage,
): message is EventProjectionCommandMessage {
  return message.kind === "command";
}

function isToolCallMessage(
  message: EventProjectionMessage,
): message is EventProjectionToolCallMessage {
  return message.kind === "tool-call";
}

function isDelegationMessage(
  message: EventProjectionMessage,
): message is EventProjectionDelegationMessage {
  return message.kind === "delegation";
}

function activeCommandMessage(
  state: ToolActivityProjectionState,
): EventProjectionCommandMessage | null {
  const { activeCell } = state.toolActivity;
  return activeCell?.kind === "command" ? activeCell : null;
}

function activeDelegationMessage(
  state: ToolActivityProjectionState,
): EventProjectionDelegationMessage | null {
  const { activeCell } = state.toolActivity;
  return activeCell?.kind === "delegation" ? activeCell : null;
}

function commandMessages(
  state: ToolActivityProjectionState,
): EventProjectionCommandMessage[] {
  return state.messages.filter(isCommandMessage);
}

function toolCallMessages(
  state: ToolActivityProjectionState,
): EventProjectionToolCallMessage[] {
  return state.messages.filter(isToolCallMessage);
}

function delegationMessages(
  state: ToolActivityProjectionState,
): EventProjectionDelegationMessage[] {
  return state.messages.filter(isDelegationMessage);
}

function beginCommand(state: ToolActivityProjectionState): void {
  onExecBegin(
    state,
    eventMeta(1),
    "thread-1",
    "turn-1",
    commandUpdate({ output: "started", status: "pending" }),
  );
}

function beginCommandWithoutOutput(state: ToolActivityProjectionState): void {
  onExecBegin(
    state,
    eventMeta(1),
    "thread-1",
    "turn-1",
    commandUpdate({ status: "pending" }),
  );
}

function beginCommandWithOutput(
  state: ToolActivityProjectionState,
  output: string,
): void {
  onExecBegin(
    state,
    eventMeta(2),
    "thread-1",
    "turn-1",
    commandUpdate({ output, status: "pending" }),
  );
}

function endCommand(
  state: ToolActivityProjectionState,
  seq: number,
  status: CommandStatus,
): void {
  onExecEnd(
    state,
    eventMeta(seq),
    "thread-1",
    "turn-1",
    commandUpdate({ output: status, status }),
  );
}

function completeCommandWithoutOutput(
  state: ToolActivityProjectionState,
): void {
  onExecEnd(
    state,
    eventMeta(3),
    "thread-1",
    "turn-1",
    commandUpdate({ status: "completed" }),
  );
}

function outputBeforeCommandBegin(
  state: ToolActivityProjectionState,
  output: string,
): void {
  onExecOutput(
    state,
    eventMeta(1),
    commandOutput({ output }),
    true,
    false,
  );
}

function applyCommandOutput(
  state: ToolActivityProjectionState,
  args: ApplyCommandOutputArgs,
): void {
  onExecOutput(
    state,
    eventMeta(args.seq),
    commandOutput({ output: args.output }),
    args.appendOutput,
    args.replaceOutput,
  );
}

function finalizedCommandStatusAfterError(
  status: CommandStatus,
): CommandStatus[] {
  const state = createProjectionState();
  beginCommand(state);
  endCommand(state, 2, status);
  endCommand(state, 3, "error");
  return commandMessages(state).map((message) => message.status);
}

describe("tool activity projection", () => {
  it("uses latest non-empty command text even when the latest command is shorter", () => {
    const state = createProjectionState();
    const staleCommand = "pnpm test -- --watch --verbose";
    const latestCommand = "pnpm t";

    onExecBegin(
      state,
      eventMeta(1),
      "thread-1",
      "turn-1",
      commandUpdate({
        command: staleCommand,
        output: "started\n",
        parsedIntents: [{ type: "unknown", cmd: staleCommand }],
        status: "pending",
      }),
    );
    onExecEnd(
      state,
      eventMeta(2),
      "thread-1",
      "turn-1",
      commandUpdate({ command: latestCommand, status: "completed" }),
    );

    expect(commandMessages(state)).toMatchObject([
      {
        command: latestCommand,
        parsedIntents: [],
      },
    ]);
  });

  it("keeps semantic tool-call intents when a later update is less specific", () => {
    const state = createProjectionState();
    const semanticIntent: EventProjectionToolParsedIntent = {
      type: "read",
      cmd: "Read src/app.ts",
      name: "Read",
      path: "src/app.ts",
    };
    const unknownIntent: EventProjectionToolParsedIntent = {
      type: "unknown",
      cmd: "Read",
    };

    onExecBegin(
      state,
      eventMeta(1),
      "thread-1",
      "turn-1",
      toolCallUpdate({
        output: "started\n",
        parsedIntents: [semanticIntent],
        status: "pending",
      }),
    );
    onExecEnd(
      state,
      eventMeta(2),
      "thread-1",
      "turn-1",
      toolCallUpdate({
        output: "done\n",
        parsedIntents: [unknownIntent],
        status: "completed",
      }),
    );

    expect(
      toolCallMessages(state).map((message) => message.parsedIntents),
    ).toEqual([[semanticIntent]]);
  });

  it("uses latest non-null duration from terminal command updates", () => {
    const state = createProjectionState();

    beginCommand(state);
    onExecEnd(
      state,
      eventMeta(2),
      "thread-1",
      "turn-1",
      commandUpdate({
        durationMs: 10,
        status: "completed",
      }),
    );
    onExecEnd(
      state,
      eventMeta(3),
      "thread-1",
      "turn-1",
      commandUpdate({
        durationMs: 25,
        status: "error",
      }),
    );

    expect(commandMessages(state).map((message) => message.durationMs)).toEqual([
      25,
    ]);
  });

  it("derives pending command duration from the latest update timestamp", () => {
    const state = createProjectionState();

    beginCommandWithoutOutput(state);
    onExecOutput(
      state,
      eventMeta(2_001),
      commandOutput({ output: "still running\n" }),
      true,
      false,
    );

    expect(activeCommandMessage(state)?.durationMs).toBe(2_000);
  });

  it("derives pending command duration from the projection's snapshot time when no progress events arrive", () => {
    // Silent pending tools — those that emit no progress events between
    // `started` and the projection snapshot — would otherwise report
    // `createdAt - startedAt = 0` because the latest event time IS the
    // start. The projection's `nowMs` provides a meaningful elapsed value
    // so the user sees real wall-clock progress for tools that don't
    // chatter on stdout.
    const state = createProjectionState();

    beginCommandWithoutOutput(state);

    // No further events. Started at seq=1, snapshot time is
    // PROJECTION_NOW_MS=2001 → elapsed should be 2000 ms.
    expect(activeCommandMessage(state)?.durationMs).toBe(2_000);
  });

  it("applies late command output to a finalized history row", () => {
    const state = createProjectionState();

    beginCommandWithOutput(state, "started\n");
    onExecEnd(
      state,
      eventMeta(3),
      "thread-1",
      "turn-1",
      commandUpdate({
        output: "done\n",
        status: "completed",
      }),
    );
    applyCommandOutput(state, {
      appendOutput: true,
      output: "late\n",
      replaceOutput: false,
      seq: 4,
    });

    expect(commandMessages(state)).toMatchObject([
      {
        output: "done\nlate\n",
        status: "completed",
      },
    ]);
  });

  it("replaces command output on reset deltas", () => {
    const state = createProjectionState();

    beginCommandWithoutOutput(state);
    applyCommandOutput(state, {
      appendOutput: true,
      output: "before reset\n",
      replaceOutput: false,
      seq: 2,
    });
    applyCommandOutput(state, {
      appendOutput: false,
      output: "after reset\n",
      replaceOutput: true,
      seq: 3,
    });
    completeCommandWithoutOutput(state);

    expect(commandMessages(state).map((message) => message.output)).toEqual([
      "after reset\n",
    ]);
  });

  it("hides partial command output until a newline or terminal flush", () => {
    const state = createProjectionState();

    beginCommandWithoutOutput(state);
    applyCommandOutput(state, {
      appendOutput: true,
      output: "partial",
      replaceOutput: false,
      seq: 2,
    });

    expect(activeCommandMessage(state)?.output).toBe("");

    applyCommandOutput(state, {
      appendOutput: true,
      output: " line\ntrailing",
      replaceOutput: false,
      seq: 3,
    });

    expect(activeCommandMessage(state)?.output).toBe("partial line\n");

    completeCommandWithoutOutput(state);

    expect(commandMessages(state).map((message) => message.output)).toEqual([
      "partial line\ntrailing",
    ]);
  });

  it("preserves equal-length pending output that differs from begin snapshot", () => {
    const state = createProjectionState();

    outputBeforeCommandBegin(state, "pre\n");
    beginCommandWithOutput(state, "run\n");
    completeCommandWithoutOutput(state);

    expect(commandMessages(state).map((message) => message.output)).toEqual([
      "pre\nrun\n",
    ]);
  });

  it("preserves pending output when a longer begin snapshot does not include it", () => {
    const state = createProjectionState();

    outputBeforeCommandBegin(state, "pre\n");
    beginCommandWithOutput(state, "begin-output\n");
    completeCommandWithoutOutput(state);

    expect(commandMessages(state).map((message) => message.output)).toEqual([
      "pre\nbegin-output\n",
    ]);
  });

  it("keeps interrupted command status when stale completion arrives", () => {
    const state = createProjectionState();
    beginCommand(state);
    interruptPendingToolActivity(state, { turnIds: new Set(["turn-1"]) });
    endCommand(state, 2, "completed");

    expect(commandMessages(state).map((message) => message.status)).toEqual([
      "interrupted",
    ]);
  });

  it("keeps interrupted delegation status when stale completion arrives", () => {
    const state = createProjectionState();

    onExecBegin(
      state,
      eventMeta(1),
      "thread-1",
      "turn-1",
      delegationUpdate({ output: "reviewing", status: "pending" }),
    );
    interruptPendingToolActivity(state, { turnIds: new Set(["turn-1"]) });

    expect(activeDelegationMessage(state)?.status).toBe("interrupted");

    onExecEnd(
      state,
      eventMeta(2),
      "thread-1",
      "turn-1",
      delegationUpdate({ output: "done", status: "completed" }),
    );

    expect(delegationMessages(state)).toMatchObject([
      {
        output: "done",
        status: "interrupted",
      },
    ]);
  });

  it("lets error replace finalized interrupted command status", () => {
    expect(finalizedCommandStatusAfterError("interrupted")).toEqual(["error"]);
  });

  it("lets error replace finalized completed command status", () => {
    expect(finalizedCommandStatusAfterError("completed")).toEqual(["error"]);
  });
});
