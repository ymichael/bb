import {
  claimQueuedThreadMessage,
  createPendingInteraction,
  createPromptHistoryEntry,
  getThread,
  listEvents,
  listStoredProjectPromptHistoryRows,
  listStoredThreadPromptHistoryRows,
  setExperiments,
} from "@bb/db";
import {
  defaultExperiments,
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type PromptInput,
  type ThreadEventTurnStatus,
  type ThreadStatus,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { editThreadMessage } from "../../src/services/threads/thread-edit-message.js";
import { requestThreadStopForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const MESSAGE_EDIT_PROVIDERS = ["codex", "pi", "claude-code"] as const;
const MESSAGE_EDIT_SCENARIOS = [
  {
    name: "regular edit",
    precedingCompletionStatus: "completed",
    selectedCompletionStatus: "completed",
    threadStatus: "idle",
  },
  {
    name: "failed edit",
    precedingCompletionStatus: "completed",
    selectedCompletionStatus: "failed",
    threadStatus: "error",
  },
  {
    name: "interrupted edit",
    precedingCompletionStatus: "completed",
    selectedCompletionStatus: "interrupted",
    threadStatus: "idle",
  },
  {
    name: "preceding failed",
    precedingCompletionStatus: "failed",
    selectedCompletionStatus: "completed",
    threadStatus: "idle",
  },
  {
    name: "preceding interrupted",
    precedingCompletionStatus: "interrupted",
    selectedCompletionStatus: "completed",
    threadStatus: "idle",
  },
] as const satisfies readonly {
  name: string;
  precedingCompletionStatus: ThreadEventTurnStatus;
  selectedCompletionStatus: ThreadEventTurnStatus;
  threadStatus: ThreadStatus;
}[];
const MESSAGE_EDIT_PROVIDER_STATUS_MATRIX = MESSAGE_EDIT_PROVIDERS.flatMap(
  (providerId) =>
    MESSAGE_EDIT_SCENARIOS.map((scenario) => ({ providerId, ...scenario })),
);

function seedTurn(
  harness: TestAppHarness,
  args: {
    providerThreadId: string;
    providerCheckpointId?: string;
    completionStatus?: ThreadEventTurnStatus | null;
    inputGroups?: PromptInput[][];
    initiator?: "agent" | "user";
    leadingAgentOnlyInput?: PromptInput[];
    requestSequence: number;
    senderThreadId?: string;
    text: string;
    threadId: string;
    turnId: string;
  },
): void {
  const requestId = encodeClientTurnRequestIdNumber({
    value: args.requestSequence,
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId,
      input: args.inputGroups?.flatMap((group, index) =>
        index === 0
          ? group
          : [{ type: "text" as const, text: "\n\n", mentions: [] }, ...group],
      ) ?? [
        ...(args.leadingAgentOnlyInput ?? []),
        { type: "text", text: args.text, mentions: [] },
      ],
      ...(args.inputGroups !== undefined
        ? { inputGroups: args.inputGroups }
        : {}),
      target:
        args.requestSequence === 2
          ? { kind: "thread-start" }
          : { kind: "new-turn" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium" as const,
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: args.initiator ?? "user",
      senderThreadId: args.senderThreadId ?? null,
      request: { method: "turn/start", params: {} },
      source: "tell",
    },
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence + 1,
    type: "turn/started",
    scope: turnScope(args.turnId),
    data: { providerThreadId: args.providerThreadId },
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence + 2,
    type: "turn/input/accepted",
    scope: turnScope(args.turnId),
    data: {
      providerThreadId: args.providerThreadId,
      clientRequestId: requestId,
    },
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence + 3,
    type: "item/completed",
    scope: turnScope(args.turnId),
    itemId: `message-${args.turnId}`,
    itemKind: "agentMessage",
    data: {
      item: {
        id: `message-${args.turnId}`,
        type: "agentMessage",
        text: `Reply to ${args.text}`,
      },
    },
  });
  if (args.completionStatus !== null) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      sequence: args.requestSequence + 4,
      type: "turn/completed",
      scope: turnScope(args.turnId),
      data: {
        providerThreadId: args.providerThreadId,
        status: args.completionStatus ?? "completed",
        ...(args.providerCheckpointId !== undefined
          ? { providerCheckpointId: args.providerCheckpointId }
          : {}),
      },
    });
  }
}

function seedEditableThread(
  harness: TestAppHarness,
  args: {
    editMessagesExperiment?: boolean;
    firstCompletionStatus?: ThreadEventTurnStatus | null;
    firstProviderCheckpoint?: string | null;
    firstProviderThreadId?: string;
    firstTurnId?: string;
    firstTurnLeadingAgentOnlyInput?: PromptInput[];
    includeIdentity?: boolean;
    includeSecondTurn?: boolean;
    providerId?: string;
    selectedCompletionStatus?: ThreadEventTurnStatus;
    threadStatus?: ThreadStatus;
  } = {},
) {
  setExperiments(harness.db, {
    ...defaultExperiments,
    editMessages: args.editMessagesExperiment ?? true,
  });
  const { host } = seedHostSession(harness.deps, {
    id: "host-edit-message",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/edit-message",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/edit-message",
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: args.providerId ?? "codex",
    status: args.threadStatus ?? "idle",
  });
  if (args.includeIdentity !== false) {
    seedStoredEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-original",
      sequence: 1,
      type: "thread/identity",
      scope: threadScope(),
      data: {},
    });
  }
  seedTurn(harness, {
    providerThreadId: args.firstProviderThreadId ?? "provider-original",
    requestSequence: 2,
    text: "First message",
    threadId: thread.id,
    turnId: args.firstTurnId ?? "turn-first",
    ...(args.firstTurnLeadingAgentOnlyInput === undefined
      ? {}
      : { leadingAgentOnlyInput: args.firstTurnLeadingAgentOnlyInput }),
    ...(args.firstCompletionStatus !== undefined
      ? { completionStatus: args.firstCompletionStatus }
      : {}),
    ...(args.firstProviderCheckpoint !== null
      ? {
          providerCheckpointId:
            args.firstProviderCheckpoint ?? "checkpoint-first",
        }
      : {}),
  });
  createPromptHistoryEntry(harness.db, {
    input: [{ type: "text", text: "First message", mentions: [] }],
    projectId: project.id,
    requestSequence: 2,
    scope: "project",
    threadId: thread.id,
  });
  if (args.includeSecondTurn !== false) {
    seedTurn(harness, {
      completionStatus: args.selectedCompletionStatus,
      providerThreadId: "provider-original",
      requestSequence: 7,
      text: "Original last message",
      threadId: thread.id,
      turnId: "turn-last",
      providerCheckpointId: "checkpoint-last",
    });
    createPromptHistoryEntry(harness.db, {
      input: [{ type: "text", text: "Original last message", mentions: [] }],
      projectId: project.id,
      requestSequence: 7,
      scope: "thread",
      threadId: thread.id,
    });
  }
  return { environment, thread };
}

describe("editThreadMessage", () => {
  it("preserves an agent caller and applies agent permission policy", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        includeSecondTurn: false,
      });
      const senderThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: thread.projectId,
        providerId: "codex",
        status: "active",
      });

      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-agent-caller",
            expectedRequestSequence: 2,
            input: [
              { type: "text", text: "Replacement by agent", mentions: [] },
            ],
            permissionMode: "accept-edits",
            senderThreadId: senderThread.id,
          },
        }),
      ).resolves.toMatchObject({ ok: true, requestSequence: 8 });

      const replacement = listEvents(harness.db, { threadId: thread.id }).find(
        (event) => event.sequence === 8,
      );
      expect(JSON.parse(replacement?.data ?? "null")).toMatchObject({
        initiator: "agent",
        senderThreadId: senderThread.id,
        execution: {
          permissionMode: "accept-edits",
        },
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Replacement by agent"),
          }),
        ],
      });
      const start = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      expect(start.command).toMatchObject({
        options: { permissionEscalation: "deny" },
      });
    });
  });

  it("rejects an unknown agent caller before rewriting history", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        includeSecondTurn: false,
      });

      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-unknown-agent",
            expectedRequestSequence: 2,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
            senderThreadId: "thread-does-not-exist",
          },
        }),
      ).rejects.toThrow("Sender thread is invalid");
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(6);
    });
  });

  it("targets the latest user message when expectedRequestSequence is omitted, skipping agent turns", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      seedTurn(harness, {
        initiator: "agent",
        providerCheckpointId: "checkpoint-agent",
        providerThreadId: "provider-original",
        requestSequence: 12,
        senderThreadId: "sender-thread",
        text: "Agent follow-up",
        threadId: thread.id,
        turnId: "turn-agent",
      });

      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-latest",
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        retainThroughProviderCheckpoint: "checkpoint-first",
      });
      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-rewind",
      });
      await expect(editPromise).resolves.toMatchObject({ ok: true });

      const marker = listEvents(harness.db, { threadId: thread.id }).find(
        (event) => event.type === "system/operation",
      );
      expect(JSON.parse(marker?.data ?? "null")).toMatchObject({
        metadata: { cutoffSequence: 7 },
      });
    });
  });

  it("replaces an earlier Codex turn and removes every later conversation turn", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);

      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-earlier-turn",
            expectedRequestSequence: 2,
            input: [
              { type: "text", text: "Replacement first message", mentions: [] },
            ],
          },
        }),
      ).resolves.toEqual({
        ok: true,
        operationId: "edit-op-earlier-turn",
        requestSequence: 13,
      });

      expect(
        listQueuedThreadCommands(harness, "thread.rewind.prepare", thread.id),
      ).toHaveLength(0);
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      expect(
        listEvents(harness.db, { threadId: thread.id }).map(
          (event) => event.sequence,
        ),
      ).toEqual([1, 12, 13]);
    });
  });

  it("replaces a turn containing an accepted steer", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        includeSecondTurn: false,
      });
      seedTurn(harness, {
        completionStatus: null,
        providerThreadId: "provider-original",
        requestSequence: 7,
        text: "Original steered message",
        threadId: thread.id,
        turnId: "turn-steered",
      });
      const steerRequestId = encodeClientTurnRequestIdNumber({ value: 11 });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "provider-original",
        sequence: 11,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: steerRequestId,
          input: [{ type: "text", text: "Accepted steer", mentions: [] }],
          target: { kind: "steer", expectedTurnId: "turn-steered" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "provider-original",
        sequence: 12,
        type: "turn/input/accepted",
        scope: turnScope("turn-steered"),
        data: {
          providerThreadId: "provider-original",
          clientRequestId: steerRequestId,
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "provider-original",
        sequence: 13,
        type: "turn/completed",
        scope: turnScope("turn-steered"),
        data: {
          providerThreadId: "provider-original",
          providerCheckpointId: "checkpoint-steered",
          status: "completed",
        },
      });

      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-steered-turn",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        retainThroughProviderCheckpoint: "checkpoint-first",
        sourceProviderThreadId: "provider-original",
      });
      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-steered-edit",
      });

      await expect(editPromise).resolves.toEqual({
        ok: true,
        operationId: "edit-op-steered-turn",
        requestSequence: 15,
      });
      const stored = listEvents(harness.db, { threadId: thread.id });
      expect(stored.map((event) => event.sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 14, 15,
      ]);
      expect(
        stored.some((event) => event.data.includes("Accepted steer")),
      ).toBe(false);
      const replacement = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      expect(replacement.command).toMatchObject({
        fork: { sourceProviderThreadId: "provider-staged-steered-edit" },
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      });
    });
  });

  it.each(["codex", "claude-code", "pi"] as const)(
    "starts a fresh %s session when editing the first turn",
    async (providerId) => {
      await withTestHarness(async (harness) => {
        const anchor = {
          type: "text" as const,
          text: "Reply anchor",
          mentions: [],
          visibility: "agent-only" as const,
        };
        const { environment, thread } = seedEditableThread(harness, {
          firstTurnLeadingAgentOnlyInput: [anchor],
          includeIdentity: false,
          includeSecondTurn: false,
          providerId,
        });
        const operationId = `edit-op-first-turn-${providerId}`;

        await expect(
          editThreadMessage(harness.deps, {
            environment,
            thread,
            payload: {
              operationId,
              expectedRequestSequence: 2,
              input: [
                {
                  type: "text",
                  text: "Replacement first message",
                  mentions: [],
                },
              ],
            },
          }),
        ).resolves.toEqual({
          ok: true,
          operationId,
          requestSequence: 8,
        });

        expect(
          listQueuedThreadCommands(harness, "thread.rewind.prepare", thread.id),
        ).toHaveLength(0);
        const replacement = await waitForQueuedCommand(
          harness,
          (queued) =>
            queued.command.type === "thread.start" &&
            queued.command.threadId === thread.id,
        );
        expect(replacement.command).toMatchObject({
          input: [anchor, { text: "Replacement first message" }],
        });
        expect(
          listQueuedThreadCommands(harness, "thread.start", thread.id),
        ).toEqual([expect.not.objectContaining({ fork: expect.anything() })]);
        expect(
          listEvents(harness.db, { threadId: thread.id }).map(
            (event) => event.sequence,
          ),
        ).toEqual([7, 8]);
        expect(
          listStoredProjectPromptHistoryRows(harness.db, {
            projectId: thread.projectId,
            limit: 10,
          }).map((entry) => entry.requestSequence),
        ).toEqual([8]);
        expect(
          listStoredThreadPromptHistoryRows(harness.db, {
            threadId: thread.id,
            limit: 10,
          }),
        ).toEqual([]);
      });
    },
  );

  it("keeps history intact until the staged Codex rewind succeeds, then replaces the suffix", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const payload = {
        operationId: "edit-op-success",
        expectedRequestSequence: 7,
        input: [
          { type: "text" as const, text: "Replacement message", mentions: [] },
        ],
        model: "gpt-5",
        serviceTier: "default" as const,
        reasoningLevel: "medium" as const,
        permissionMode: "full" as const,
      };
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload,
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        sourceProviderThreadId: "provider-original",
        retainThroughProviderCheckpoint: "checkpoint-first",
        threadId: thread.id,
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(11);

      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-rewind",
      });
      await expect(editPromise).resolves.toEqual({
        ok: true,
        operationId: "edit-op-success",
        requestSequence: 13,
      });

      const stored = listEvents(harness.db, { threadId: thread.id });
      expect(stored.map((event) => event.sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 12, 13,
      ]);
      const replacement = stored.find((event) => event.sequence === 13);
      expect(replacement).toMatchObject({ type: "client/turn/requested" });
      expect(JSON.parse(replacement?.data ?? "null")).toMatchObject({
        input: [{ type: "text", text: "Replacement message", mentions: [] }],
      });
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "active",
      });
      const replacementStart = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toEqual([
        expect.objectContaining({
          fork: { sourceProviderThreadId: "provider-staged-rewind" },
          input: [{ type: "text", text: "Replacement message", mentions: [] }],
        }),
      ]);
      await reportQueuedCommandSuccess(harness, replacementStart, {
        providerThreadId: "provider-replacement",
      });
      const discard = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.discard",
      );
      expect(discard.command).toMatchObject({
        leaseId:
          rewind.command.type === "thread.rewind.prepare"
            ? rewind.command.leaseId
            : undefined,
        threadId: thread.id,
      });
      await reportQueuedCommandSuccess(harness, discard, {});
      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload,
        }),
      ).resolves.toEqual({
        ok: true,
        operationId: "edit-op-success",
        requestSequence: 13,
      });
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(
        listStoredProjectPromptHistoryRows(harness.db, {
          projectId: thread.projectId,
          limit: 10,
        }).map((entry) => entry.requestSequence),
      ).toEqual([2]);
      expect(
        listStoredThreadPromptHistoryRows(harness.db, {
          threadId: thread.id,
          limit: 10,
        }).map((entry) => entry.requestSequence),
      ).toEqual([13]);
    });
  });

  it("returns the committed result to an overlapping retry of the same operation", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const payload = {
        operationId: "edit-op-overlapping-retry",
        expectedRequestSequence: 7,
        input: [
          { type: "text" as const, text: "Replacement message", mentions: [] },
        ],
      };

      const firstEdit = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload,
      });
      const secondEdit = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload,
      });
      const editsResult = expect(
        Promise.all([firstEdit, secondEdit]),
      ).resolves.toEqual([
        {
          ok: true,
          operationId: payload.operationId,
          requestSequence: 13,
        },
        {
          ok: true,
          operationId: payload.operationId,
          requestSequence: 13,
        },
      ]);
      const firstRewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      const secondRewind = await waitForQueuedCommandAfter(
        harness,
        firstRewind.row.cursor,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      await reportQueuedCommandSuccess(harness, firstRewind, {
        providerThreadId: "provider-staged-overlap",
      });
      await reportQueuedCommandSuccess(harness, secondRewind, {
        providerThreadId: "provider-staged-overlap",
      });

      const losingLeaseDiscard = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.discard",
      );
      await reportQueuedCommandSuccess(harness, losingLeaseDiscard, {});

      await editsResult;
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(1);
    });
  });

  it.each(MESSAGE_EDIT_PROVIDER_STATUS_MATRIX)(
    "$providerId supports $name",
    async ({
      name,
      precedingCompletionStatus,
      providerId,
      selectedCompletionStatus,
      threadStatus,
    }) => {
      await withTestHarness(async (harness) => {
        const { environment, thread } = seedEditableThread(harness, {
          firstCompletionStatus: precedingCompletionStatus,
          providerId,
          selectedCompletionStatus,
          threadStatus,
        });
        const operationId = `edit-op-${providerId}-${name.replaceAll(" ", "-")}`;
        const editPromise = editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId,
            expectedRequestSequence: 7,
            input: [
              { type: "text", text: "Replacement message", mentions: [] },
            ],
          },
        });

        const rewind = await waitForQueuedCommand(
          harness,
          (queued) => queued.command.type === "thread.rewind.prepare",
        );
        expect(rewind.command).toMatchObject({
          providerId,
          retainThroughProviderCheckpoint: "checkpoint-first",
          sourceProviderThreadId: "provider-original",
        });
        if (rewind.command.type !== "thread.rewind.prepare") {
          throw new Error("Expected a thread.rewind.prepare command");
        }
        await reportQueuedCommandSuccess(harness, rewind, {
          providerThreadId: `provider-staged-${providerId}`,
        });
        await expect(editPromise).resolves.toMatchObject({
          ok: true,
          operationId,
        });
      });
    },
  );

  it("edits after stopping a Pi turn and completing the next turn", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        firstCompletionStatus: null,
        firstProviderCheckpoint: null,
        includeSecondTurn: false,
        providerId: "pi",
        threadStatus: "active",
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stop = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.stop",
      );
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: "pi-entry-after-abort",
      });

      seedTurn(harness, {
        providerCheckpointId: "pi-entry-next-completion",
        providerThreadId: "provider-original",
        requestSequence: 8,
        text: "Original last message",
        threadId: thread.id,
        turnId: "turn-last",
      });
      createPromptHistoryEntry(harness.db, {
        input: [{ type: "text", text: "Original last message", mentions: [] }],
        projectId: thread.projectId,
        requestSequence: 8,
        scope: "thread",
        threadId: thread.id,
      });

      const stoppedThread = getThread(harness.db, thread.id);
      if (!stoppedThread) {
        throw new Error("Expected stopped Pi thread");
      }
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread: stoppedThread,
        payload: {
          operationId: "edit-op-pi-after-stopped-turn",
          expectedRequestSequence: 8,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });

      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        providerId: "pi",
        retainThroughProviderCheckpoint: "pi-entry-after-abort",
        sourceProviderThreadId: "provider-original",
      });
      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-pi-after-stop",
      });

      await expect(editPromise).resolves.toMatchObject({
        ok: true,
        operationId: "edit-op-pi-after-stopped-turn",
      });
    });
  });

  it("uses the provider lineage that produced the preceding checkpoint", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        firstProviderThreadId: "provider-before-restart",
      });
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-provider-lineage",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        sourceProviderThreadId: "provider-before-restart",
      });
      const rejectedEdit = expect(editPromise).rejects.toThrow(
        "Stop after inspecting command",
      );
      await reportQueuedCommandError(harness, rewind, {
        errorCode: "test_complete",
        errorMessage: "Stop after inspecting command",
      });
      await rejectedEdit;
    });
  });

  it("rejects grouped requests", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      seedTurn(harness, {
        inputGroups: [
          [{ type: "text", text: "Grouped first", mentions: [] }],
          [{ type: "text", text: "Grouped second", mentions: [] }],
        ],
        providerCheckpointId: "checkpoint-grouped",
        providerThreadId: "provider-original",
        requestSequence: 12,
        text: "Grouped request",
        threadId: thread.id,
        turnId: "turn-grouped",
      });

      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-grouped",
            expectedRequestSequence: 12,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        }),
      ).rejects.toThrow("Grouped messages cannot be edited yet");
    });
  });

  it("resolves the latest edit past ineligible candidates", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      seedTurn(harness, {
        inputGroups: [
          [{ type: "text", text: "Grouped a", mentions: [] }],
          [{ type: "text", text: "Grouped b", mentions: [] }],
        ],
        providerCheckpointId: "checkpoint-grouped",
        providerThreadId: "provider-original",
        requestSequence: 12,
        text: "Grouped request",
        threadId: thread.id,
        turnId: "turn-grouped",
      });

      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-paginated",
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rejectedEdit =
        expect(editPromise).rejects.toThrow("Codex fork failed");
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        retainThroughProviderCheckpoint: "checkpoint-first",
      });
      await reportQueuedCommandError(harness, rewind, {
        errorCode: "provider_error",
        errorMessage: "Codex fork failed",
      });
      await rejectedEdit;
    });
  });

  it("edits an idle selected turn without a completion event", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      seedTurn(harness, {
        completionStatus: null,
        providerThreadId: "provider-original",
        requestSequence: 12,
        text: "Incomplete request",
        threadId: thread.id,
        turnId: "turn-incomplete",
      });

      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-incomplete-turn",
          expectedRequestSequence: 12,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-incomplete-edit",
      });

      await expect(editPromise).resolves.toMatchObject({
        ok: true,
        operationId: "edit-op-incomplete-turn",
      });
    });
  });

  it("stops an active selected turn before editing it", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        threadStatus: "active",
      });
      seedTurn(harness, {
        completionStatus: null,
        providerThreadId: "provider-original",
        requestSequence: 12,
        text: "Running request",
        threadId: thread.id,
        turnId: "turn-running",
      });

      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-active-turn",
          expectedRequestSequence: 12,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const stop = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.stop",
      );
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.rewind.prepare", thread.id),
      ).toHaveLength(0);
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });

      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-active-edit",
      });

      await expect(editPromise).resolves.toMatchObject({
        ok: true,
        operationId: "edit-op-active-turn",
      });
    });
  });

  it("rechecks claimed queued messages after rewind preparation", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-queue-race",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      const queuedMessage = seedQueuedMessage(harness.deps, {
        content: [
          { type: "text", text: "Queued while preparing", mentions: [] },
        ],
        threadId: thread.id,
      });
      expect(
        claimQueuedThreadMessage(
          harness.db,
          harness.deps.hub,
          queuedMessage.id,
        ),
      ).not.toBeNull();
      const rejectedEdit = expect(editPromise).rejects.toThrow(
        "Send or remove queued messages before editing a message",
      );
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-queue-race",
      });
      const discard = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.discard",
      );
      expect(discard.command).toMatchObject({
        leaseId:
          rewind.command.type === "thread.rewind.prepare"
            ? rewind.command.leaseId
            : undefined,
      });
      await reportQueuedCommandSuccess(harness, discard, {});
      await rejectedEdit;
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(11);
    });
  });

  it("rechecks pending interactions in the edit commit transaction", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      let pendingInteractionChecks = 0;
      const originalHasPendingInteraction =
        harness.deps.pendingInteractions.hasPendingThreadInteraction.bind(
          harness.deps.pendingInteractions,
        );
      const pendingInteractionSpy = vi
        .spyOn(harness.deps.pendingInteractions, "hasPendingThreadInteraction")
        .mockImplementation((threadId) => {
          pendingInteractionChecks += 1;
          if (pendingInteractionChecks === 2) {
            createPendingInteraction(harness.db, {
              originKind: "plugin",
              pluginId: "plugin-edit-race",
              rendererId: "renderer-edit-race",
              threadId,
              turnId: null,
              payload: JSON.stringify({ kind: "plugin", title: "Confirm" }),
            });
            return false;
          }
          return originalHasPendingInteraction(threadId);
        });
      try {
        const editPromise = editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-interaction-race",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        });
        const rewind = await waitForQueuedCommand(
          harness,
          (queued) => queued.command.type === "thread.rewind.prepare",
        );
        const rejectedEdit = expect(editPromise).rejects.toThrow(
          "Resolve the pending interaction before editing the message",
        );
        await reportQueuedCommandSuccess(harness, rewind, {
          providerThreadId: "provider-staged-interaction-race",
        });
        const discard = await waitForQueuedCommand(
          harness,
          (queued) => queued.command.type === "thread.rewind.discard",
        );
        await reportQueuedCommandSuccess(harness, discard, {});
        await rejectedEdit;
        expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
          11,
        );
      } finally {
        pendingInteractionSpy.mockRestore();
      }
    });
  });

  it("discards the staged rewind when the thread changes before commit", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-high-water-race",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      seedStoredEvent(harness.deps, {
        data: { operation: "concurrent-change" },
        sequence: 12,
        scope: threadScope(),
        threadId: thread.id,
        type: "system/operation",
      });
      const rejectedEdit = expect(editPromise).rejects.toThrow(
        "The thread changed while the edit was being prepared",
      );
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-high-water-race",
      });
      const discard = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.discard",
      );
      await reportQueuedCommandSuccess(harness, discard, {});
      await rejectedEdit;
      expect(
        listEvents(harness.db, { threadId: thread.id }).map(
          (event) => event.sequence,
        ),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });
  });

  it.each(["claude-code", "pi"] as const)(
    "rejects a %s rewind through legacy history without a checkpoint",
    async (providerId) => {
      await withTestHarness(async (harness) => {
        const { environment, thread } = seedEditableThread(harness, {
          firstProviderCheckpoint: null,
          providerId,
        });

        await expect(
          editThreadMessage(harness.deps, {
            environment,
            thread,
            payload: {
              operationId: `edit-op-legacy-${providerId}`,
              expectedRequestSequence: 7,
              input: [{ type: "text", text: "Replacement", mentions: [] }],
            },
          }),
        ).rejects.toThrow("no editable history checkpoint");
        expect(
          listQueuedThreadCommands(harness, "thread.rewind.prepare", thread.id),
        ).toHaveLength(0);
      });
    },
  );

  it("falls back to a legacy Codex turn id when history has no checkpoint", async () => {
    await withTestHarness(async (harness) => {
      const legacyCodexTurnId = "019f1234-5678-7abc-8def-0123456789ab";
      const { environment, thread } = seedEditableThread(harness, {
        firstProviderCheckpoint: null,
        firstTurnId: legacyCodexTurnId,
      });
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-legacy-codex",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });

      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      expect(rewind.command).toMatchObject({
        retainThroughProviderCheckpoint: legacyCodexTurnId,
      });
      if (rewind.command.type !== "thread.rewind.prepare") {
        throw new Error("Expected a thread.rewind.prepare command");
      }
      await reportQueuedCommandSuccess(harness, rewind, {
        providerThreadId: "provider-staged-legacy-codex",
      });
      await expect(editPromise).resolves.toMatchObject({ ok: true });
    });
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "does not send a bb turn id to Codex when a %s turn has no checkpoint",
    async (firstCompletionStatus) => {
      await withTestHarness(async (harness) => {
        const { environment, thread } = seedEditableThread(harness, {
          firstCompletionStatus,
          firstProviderCheckpoint: null,
          firstTurnId: "da2f291120-t3",
        });

        await expect(
          editThreadMessage(harness.deps, {
            environment,
            thread,
            payload: {
              operationId: `edit-op-missing-${firstCompletionStatus}-codex-checkpoint`,
              expectedRequestSequence: 7,
              input: [{ type: "text", text: "Replacement", mentions: [] }],
            },
          }),
        ).rejects.toThrow("no editable history checkpoint");
        expect(
          listQueuedThreadCommands(harness, "thread.rewind.prepare", thread.id),
        ).toHaveLength(0);
      });
    },
  );

  it("leaves the original suffix untouched when Codex cannot stage the rewind", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const editPromise = editThreadMessage(harness.deps, {
        environment,
        thread,
        payload: {
          operationId: "edit-op-failure",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });
      const rejectedEdit =
        expect(editPromise).rejects.toThrow("Codex fork failed");
      const rewind = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.rewind.prepare",
      );
      await reportQueuedCommandError(harness, rewind, {
        errorCode: "provider_error",
        errorMessage: "Codex fork failed",
      });

      await rejectedEdit;
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(11);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
    });
  });

  it("rejects an edit on a provider that declares no session rewind", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        providerId: "acp-cursor",
      });

      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-no-rewind",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        }),
      ).rejects.toThrow("Editing messages is not supported for acp-cursor");
    });
  });

  it("rejects mutations while the experiment is disabled", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness, {
        editMessagesExperiment: false,
      });

      await expect(
        editThreadMessage(harness.deps, {
          environment,
          thread,
          payload: {
            operationId: "edit-op-disabled",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        }),
      ).rejects.toThrow("Enable the Edit messages experiment");
    });
  });
});
