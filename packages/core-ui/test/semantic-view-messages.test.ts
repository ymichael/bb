import { describe, expect, it } from "vitest";
import type {
  ViewAssistantTextMessage,
  ViewDelegationMessage,
  ViewMessage,
  ViewProjection,
  ViewToolCallMessage,
  ViewTurn,
} from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import {
  normalizeSemanticViewMessages,
  normalizeSemanticViewProjection,
} from "../src/semantic-view-messages.js";

interface ToolCallFixtureArgs {
  callId: string;
  id: string;
  parentToolCallId?: string;
  seq: number;
  toolName: string;
  turnId?: string;
}

interface AssistantFixtureArgs {
  id: string;
  parentToolCallId?: string;
  seq: number;
  text: string;
  turnId?: string;
}

interface TurnFixtureArgs {
  messages: ViewMessage[];
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  turnId: string;
}

function toolCallMessage(args: ToolCallFixtureArgs): ViewToolCallMessage {
  const scopeFields = args.turnId
    ? { scope: turnScope(args.turnId), turnId: args.turnId }
    : { scope: threadScope() };
  return {
    kind: "tool-call",
    id: args.id,
    threadId: "thread-1",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    createdAt: args.seq * 10,
    ...scopeFields,
    ...(args.parentToolCallId
      ? { parentToolCallId: args.parentToolCallId }
      : {}),
    toolName: args.toolName,
    toolArgs: null,
    callId: args.callId,
    parsedIntents: [],
    output: "",
    durationMs: null,
    approvalStatus: null,
    status: "completed",
  };
}

function delegationMessage(args: ToolCallFixtureArgs): ViewDelegationMessage {
  const toolCall = toolCallMessage(args);
  return {
    kind: "delegation",
    id: toolCall.id,
    threadId: toolCall.threadId,
    sourceSeqStart: toolCall.sourceSeqStart,
    sourceSeqEnd: toolCall.sourceSeqEnd,
    createdAt: toolCall.createdAt,
    scope: toolCall.scope,
    ...(toolCall.parentToolCallId
      ? { parentToolCallId: toolCall.parentToolCallId }
      : {}),
    toolName: toolCall.toolName,
    callId: toolCall.callId,
    output: "",
    durationMs: null,
    status: toolCall.status,
    childProjection: {
      state: {
        activeThinking: null,
      },
      entries: [],
    },
  };
}

function assistantMessage(
  args: AssistantFixtureArgs,
): ViewAssistantTextMessage {
  const scopeFields = args.turnId
    ? { scope: turnScope(args.turnId), turnId: args.turnId }
    : { scope: threadScope() };
  return {
    kind: "assistant-text",
    id: args.id,
    threadId: "thread-1",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    createdAt: args.seq * 10,
    ...scopeFields,
    ...(args.parentToolCallId
      ? { parentToolCallId: args.parentToolCallId }
      : {}),
    text: args.text,
    status: "completed",
  };
}

function projectionTurn(args: TurnFixtureArgs): ViewTurn {
  const sourceSeqStart =
    args.sourceSeqStart ??
    Math.min(...args.messages.map((message) => message.sourceSeqStart));
  const sourceSeqEnd =
    args.sourceSeqEnd ??
    Math.max(...args.messages.map((message) => message.sourceSeqEnd));
  const startedAt = Math.min(
    ...args.messages.map((message) => message.startedAt ?? message.createdAt),
  );
  const createdAt = Math.max(
    ...args.messages.map((message) => message.createdAt),
  );
  return {
    turnId: args.turnId,
    threadId: "thread-1",
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    completedAt: createdAt,
    status: "completed",
    summaryCount: 0,
    messages: args.messages,
  };
}

function projectionFromTurn(turn: ViewTurn): ViewProjection {
  return {
    state: {
      activeThinking: null,
    },
    entries: [
      {
        kind: "turn",
        turn,
      },
    ],
  };
}

function projectionMessages(projection: ViewProjection): ViewMessage[] {
  const messages: ViewMessage[] = [];
  for (const entry of projection.entries) {
    if (entry.kind === "message") {
      messages.push(entry.message);
      continue;
    }
    messages.push(...(entry.turn.messages ?? []));
  }
  return messages;
}

function onlyDelegation(message: ViewMessage): ViewDelegationMessage {
  expect(message.kind).toBe("delegation");
  if (message.kind !== "delegation") {
    throw new Error("Expected delegation message");
  }
  return message;
}

describe("normalizeSemanticViewProjection", () => {
  it("recomputes child projection turn metadata from the child range", () => {
    const delegation = delegationMessage({
      id: "delegate-1",
      callId: "delegate-call-1",
      toolName: "Agent",
      seq: 10,
      turnId: "turn-1",
    });
    const child = toolCallMessage({
      id: "child-1",
      callId: "child-call-1",
      toolName: "exec_command",
      parentToolCallId: "delegate-call-1",
      seq: 25,
      turnId: "turn-1",
    });
    const terminal = assistantMessage({
      id: "assistant-1",
      text: "done",
      seq: 100,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 100,
          messages: [delegation, child, terminal],
        }),
      ),
    );

    const rootMessages = projectionMessages(normalized);
    const normalizedDelegation = onlyDelegation(rootMessages[0]!);
    const childEntry = normalizedDelegation.childProjection.entries[0];
    expect(childEntry?.kind).toBe("turn");
    if (childEntry?.kind !== "turn") {
      throw new Error("Expected child turn entry");
    }
    expect(childEntry.turn.sourceSeqStart).toBe(25);
    expect(childEntry.turn.sourceSeqEnd).toBe(25);
    expect(childEntry.turn.startedAt).toBe(250);
    expect(childEntry.turn.createdAt).toBe(250);
    expect(childEntry.turn.completedAt).toBe(250);
    expect(childEntry.turn.summaryCount).toBe(1);
    expect(childEntry.turn.terminalMessage).toBeUndefined();
  });

  it("does not attach children to non-delegation tool calls", () => {
    const parent = toolCallMessage({
      id: "tool-1",
      callId: "tool-call-1",
      toolName: "exec_command",
      seq: 1,
      turnId: "turn-1",
    });
    const child = assistantMessage({
      id: "assistant-1",
      text: "tool output",
      parentToolCallId: "tool-call-1",
      seq: 2,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          messages: [parent, child],
        }),
      ),
    );

    expect(projectionMessages(normalized).map((message) => message.id)).toEqual(
      ["tool-1", "assistant-1"],
    );
  });

  it("does not convert raw Agent tool calls into delegation rows", () => {
    const parent = toolCallMessage({
      id: "tool-1",
      callId: "tool-call-1",
      toolName: "Agent",
      seq: 1,
      turnId: "turn-1",
    });
    const child = assistantMessage({
      id: "assistant-1",
      text: "tool output",
      parentToolCallId: "tool-call-1",
      seq: 2,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          messages: [parent, child],
        }),
      ),
    );

    expect(
      projectionMessages(normalized).map((message) => message.kind),
    ).toEqual(["tool-call", "assistant-text"]);
  });

  it("keeps sibling delegation children isolated", () => {
    const firstDelegation = delegationMessage({
      id: "delegate-1",
      callId: "delegate-call-1",
      toolName: "Agent",
      seq: 1,
      turnId: "turn-1",
    });
    const secondDelegation = delegationMessage({
      id: "delegate-2",
      callId: "delegate-call-2",
      toolName: "Agent",
      seq: 2,
      turnId: "turn-1",
    });
    const firstChild = assistantMessage({
      id: "assistant-1",
      text: "first child",
      parentToolCallId: "delegate-call-1",
      seq: 3,
      turnId: "turn-1",
    });
    const secondChild = assistantMessage({
      id: "assistant-2",
      text: "second child",
      parentToolCallId: "delegate-call-2",
      seq: 4,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          messages: [
            firstDelegation,
            secondDelegation,
            firstChild,
            secondChild,
          ],
        }),
      ),
    );

    const rootMessages = projectionMessages(normalized);
    const normalizedFirstDelegation = onlyDelegation(rootMessages[0]!);
    const normalizedSecondDelegation = onlyDelegation(rootMessages[1]!);
    expect(
      projectionMessages(normalizedFirstDelegation.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-1"]);
    expect(
      projectionMessages(normalizedSecondDelegation.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-2"]);
  });

  it("attaches children to delegation rows", () => {
    const delegation = delegationMessage({
      id: "delegate-1",
      callId: "delegate-call-1",
      toolName: "Agent",
      seq: 1,
      turnId: "turn-1",
    });
    const child = assistantMessage({
      id: "assistant-1",
      text: "child",
      parentToolCallId: "delegate-call-1",
      seq: 2,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          messages: [delegation, child],
        }),
      ),
    );

    const normalizedDelegation = onlyDelegation(
      projectionMessages(normalized)[0]!,
    );
    expect(
      projectionMessages(normalizedDelegation.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-1"]);
  });

  it("preserves existing delegation children while adding discovered child rows", () => {
    const existingChild = assistantMessage({
      id: "assistant-existing",
      text: "existing child",
      seq: 2,
      turnId: "turn-1",
    });
    const delegation = {
      ...delegationMessage({
        id: "delegate-1",
        callId: "delegate-call-1",
        toolName: "Agent",
        seq: 1,
        turnId: "turn-1",
      }),
      childProjection: {
        state: {
          activeThinking: null,
        },
        entries: [
          {
            kind: "message",
            message: existingChild,
          },
        ],
      },
    };
    const discoveredChild = assistantMessage({
      id: "assistant-discovered",
      text: "discovered child",
      parentToolCallId: "delegate-call-1",
      seq: 3,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          messages: [delegation, discoveredChild],
        }),
      ),
    );

    const normalizedDelegation = onlyDelegation(
      projectionMessages(normalized)[0]!,
    );
    expect(
      projectionMessages(normalizedDelegation.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-existing", "assistant-discovered"]);
  });

  it("nests delegation chains without leaking descendants to ancestor top levels", () => {
    const levelOne = delegationMessage({
      id: "delegate-1",
      callId: "delegate-call-1",
      toolName: "Agent",
      seq: 1,
      turnId: "turn-1",
    });
    const levelTwo = delegationMessage({
      id: "delegate-2",
      callId: "delegate-call-2",
      toolName: "Agent",
      parentToolCallId: "delegate-call-1",
      seq: 2,
      turnId: "turn-1",
    });
    const levelThree = delegationMessage({
      id: "delegate-3",
      callId: "delegate-call-3",
      toolName: "Agent",
      parentToolCallId: "delegate-call-2",
      seq: 3,
      turnId: "turn-1",
    });
    const leaf = assistantMessage({
      id: "assistant-1",
      text: "leaf",
      parentToolCallId: "delegate-call-3",
      seq: 4,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewProjection(
      projectionFromTurn(
        projectionTurn({
          turnId: "turn-1",
          messages: [levelOne, levelTwo, levelThree, leaf],
        }),
      ),
    );

    const normalizedLevelOne = onlyDelegation(
      projectionMessages(normalized)[0]!,
    );
    const normalizedLevelTwo = onlyDelegation(
      projectionMessages(normalizedLevelOne.childProjection)[0]!,
    );
    const normalizedLevelThree = onlyDelegation(
      projectionMessages(normalizedLevelTwo.childProjection)[0]!,
    );

    expect(
      projectionMessages(normalizedLevelOne.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["delegate-2"]);
    expect(
      projectionMessages(normalizedLevelTwo.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["delegate-3"]);
    expect(
      projectionMessages(normalizedLevelThree.childProjection).map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-1"]);
  });
});

describe("normalizeSemanticViewMessages", () => {
  it("normalizes flat messages without synthesizing turn entries", () => {
    const delegation = delegationMessage({
      id: "delegate-1",
      callId: "delegate-call-1",
      toolName: "Agent",
      seq: 1,
      turnId: "turn-1",
    });
    const child = assistantMessage({
      id: "assistant-1",
      text: "child",
      parentToolCallId: "delegate-call-1",
      seq: 2,
      turnId: "turn-1",
    });

    const normalized = normalizeSemanticViewMessages([delegation, child]);
    const normalizedDelegation = onlyDelegation(normalized[0]!);
    expect(normalized).toHaveLength(1);
    expect(normalizedDelegation.childProjection.entries).toEqual([
      {
        kind: "message",
        message: child,
      },
    ]);
  });
});
