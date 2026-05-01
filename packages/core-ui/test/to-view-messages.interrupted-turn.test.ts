import { describe, expect, it } from "vitest";
import type { ThreadEventRow, ViewMessage } from "@bb/domain";
import { toViewMessages } from "../src/to-view-messages.js";
import {
  createTimelineEventFactory,
  fromRows,
  type TimelineEventFactory,
} from "./timeline-test-harness.js";

interface PendingEventBuilderArgs {
  event: TimelineEventFactory;
  itemId: string;
  turnId: string;
}

interface MessageAssertionArgs {
  itemId: string;
  messages: readonly ViewMessage[];
}

interface InterruptedTurnProjectionScenario {
  assertInterrupted: (args: MessageAssertionArgs) => void;
  assertPending: (args: MessageAssertionArgs) => void;
  buildPendingEvents: (args: PendingEventBuilderArgs) => ThreadEventRow[];
  name: string;
  newId: string;
  oldId: string;
}

function buildScenarioEvents(
  scenario: InterruptedTurnProjectionScenario,
): ThreadEventRow[] {
  const event = createTimelineEventFactory({
    threadId: "thread-1",
    providerThreadId: "provider-thread-1",
  });

  return [
    event.turnStarted({ turnId: "turn-1" }),
    ...scenario.buildPendingEvents({
      event,
      itemId: scenario.oldId,
      turnId: "turn-1",
    }),
    event.turnCompleted({
      turnId: "turn-1",
      status: "interrupted",
    }),
    event.clientTurnRequested({
      text: "Keep going",
    }),
    event.turnStarted({ turnId: "turn-2" }),
    ...scenario.buildPendingEvents({
      event,
      itemId: scenario.newId,
      turnId: "turn-2",
    }),
  ];
}

function findToolCallMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "tool-call" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call" && message.callId === itemId,
    ) ?? null
  );
}

function findCommandMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "command" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "command" }> =>
        message.kind === "command" && message.callId === itemId,
    ) ?? null
  );
}

function findDelegationMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "delegation" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "delegation" }> =>
        message.kind === "delegation" && message.callId === itemId,
    ) ?? null
  );
}

function findWebSearchMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "web-search" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "web-search" }> =>
        message.kind === "web-search" && message.callId === itemId,
    ) ?? null
  );
}

function findWebFetchMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "web-fetch" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "web-fetch" }> =>
        message.kind === "web-fetch" && message.callId === itemId,
    ) ?? null
  );
}

function findFileEditMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "file-edit" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit" && message.callId === itemId,
    ) ?? null
  );
}

function findOperationMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "operation" }> | null {
  return (
    messages.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation" && message.id.includes(itemId),
    ) ?? null
  );
}

function findPermissionGrantMessage(
  messages: readonly ViewMessage[],
  itemId: string,
): Extract<ViewMessage, { kind: "permission-grant-lifecycle" }> | null {
  return (
    messages.find(
      (
        message,
      ): message is Extract<
        ViewMessage,
        { kind: "permission-grant-lifecycle" }
      > =>
        message.kind === "permission-grant-lifecycle" &&
        message.approvalTarget.itemId === itemId,
    ) ?? null
  );
}

function expectToolCallInterrupted(args: MessageAssertionArgs): void {
  expect(findToolCallMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
    output: "Tool execution interrupted",
  });
}

function expectToolCallPending(args: MessageAssertionArgs): void {
  expect(findToolCallMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectCommandInterrupted(args: MessageAssertionArgs): void {
  expect(findCommandMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
    output: "Tool execution interrupted",
  });
}

function expectCommandPending(args: MessageAssertionArgs): void {
  expect(findCommandMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectDelegationInterrupted(args: MessageAssertionArgs): void {
  expect(findDelegationMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
    output: "Tool execution interrupted",
  });
}

function expectDelegationPending(args: MessageAssertionArgs): void {
  expect(findDelegationMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectWebSearchInterrupted(args: MessageAssertionArgs): void {
  expect(findWebSearchMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
  });
}

function expectWebSearchPending(args: MessageAssertionArgs): void {
  expect(findWebSearchMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectWebFetchInterrupted(args: MessageAssertionArgs): void {
  expect(findWebFetchMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
  });
}

function expectWebFetchPending(args: MessageAssertionArgs): void {
  expect(findWebFetchMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectFileEditInterrupted(args: MessageAssertionArgs): void {
  expect(findFileEditMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
  });
}

function expectFileEditPending(args: MessageAssertionArgs): void {
  expect(findFileEditMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectOperationInterrupted(args: MessageAssertionArgs): void {
  expect(findOperationMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
  });
}

function expectOperationPending(args: MessageAssertionArgs): void {
  expect(findOperationMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

function expectPermissionGrantInterrupted(args: MessageAssertionArgs): void {
  expect(findPermissionGrantMessage(args.messages, args.itemId)).toMatchObject({
    status: "interrupted",
    title: "Permission grant interrupted",
  });
}

function expectPermissionGrantPending(args: MessageAssertionArgs): void {
  expect(findPermissionGrantMessage(args.messages, args.itemId)).toMatchObject({
    status: "pending",
  });
}

const scenarios: InterruptedTurnProjectionScenario[] = [
  {
    name: "command",
    oldId: "command-old",
    newId: "command-new",
    buildPendingEvents: (args) => [
      args.event.commandStarted({
        turnId: args.turnId,
        itemId: args.itemId,
        command: `echo ${args.itemId}`,
      }),
    ],
    assertInterrupted: expectCommandInterrupted,
    assertPending: expectCommandPending,
  },
  {
    name: "read tool-call",
    oldId: "read-old",
    newId: "read-new",
    buildPendingEvents: (args) => [
      args.event.toolCallStarted({
        turnId: args.turnId,
        itemId: args.itemId,
        tool: "Read",
        arguments: { file_path: `/repo/${args.itemId}.md` },
      }),
    ],
    assertInterrupted: expectToolCallInterrupted,
    assertPending: expectToolCallPending,
  },
  {
    name: "delegation",
    oldId: "agent-old",
    newId: "agent-new",
    buildPendingEvents: (args) => [
      args.event.toolCallStarted({
        turnId: args.turnId,
        itemId: args.itemId,
        tool: "Agent",
        arguments: {
          subagent_type: "Explore",
          description: args.itemId,
        },
      }),
    ],
    assertInterrupted: expectDelegationInterrupted,
    assertPending: expectDelegationPending,
  },
  {
    name: "web-search",
    oldId: "search-old",
    newId: "search-new",
    buildPendingEvents: (args) => [
      args.event.webSearchStarted({
        turnId: args.turnId,
        itemId: args.itemId,
        queries: [args.itemId],
      }),
    ],
    assertInterrupted: expectWebSearchInterrupted,
    assertPending: expectWebSearchPending,
  },
  {
    name: "web-fetch",
    oldId: "fetch-old",
    newId: "fetch-new",
    buildPendingEvents: (args) => [
      args.event.webFetchStarted({
        turnId: args.turnId,
        itemId: args.itemId,
        url: `https://example.com/${args.itemId}`,
      }),
    ],
    assertInterrupted: expectWebFetchInterrupted,
    assertPending: expectWebFetchPending,
  },
  {
    name: "file-edit",
    oldId: "file-old",
    newId: "file-new",
    buildPendingEvents: (args) => [
      args.event.fileChangeStarted({
        turnId: args.turnId,
        itemId: args.itemId,
        changes: [
          {
            path: `/repo/${args.itemId}.ts`,
            kind: "update",
            diff: "@@ -1 +1 @@",
          },
        ],
      }),
    ],
    assertInterrupted: expectFileEditInterrupted,
    assertPending: expectFileEditPending,
  },
  {
    name: "operation",
    oldId: "turn-1",
    newId: "turn-2",
    buildPendingEvents: (args) => [
      args.event.contextCompactionStarted({
        turnId: args.turnId,
        itemId: args.itemId,
      }),
    ],
    assertInterrupted: expectOperationInterrupted,
    assertPending: expectOperationPending,
  },
  {
    name: "permission-grant-lifecycle",
    oldId: "grant-old",
    newId: "grant-new",
    buildPendingEvents: (args) => [
      args.event.permissionGrantLifecycle({
        turnId: args.turnId,
        interactionId: `pi-${args.itemId}`,
        itemId: args.itemId,
      }),
    ],
    assertInterrupted: expectPermissionGrantInterrupted,
    assertPending: expectPermissionGrantPending,
  },
];

describe("toViewMessages interrupted turn finalization", () => {
  for (const scenario of scenarios) {
    it(`interrupts old pending ${scenario.name} messages without touching active follow-up work`, () => {
      const messages = toViewMessages(fromRows(buildScenarioEvents(scenario)), {
        threadStatus: "active",
      });

      scenario.assertInterrupted({
        itemId: scenario.oldId,
        messages,
      });
      scenario.assertPending({
        itemId: scenario.newId,
        messages,
      });
    });
  }
});
