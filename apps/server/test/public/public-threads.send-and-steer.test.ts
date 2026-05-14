import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  events,
  getDraft,
  getThread,
  hostDaemonCommands,
  listEvents,
  markThreadDeleted,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  type PromptInput,
  type TurnRequestEventData,
  turnRequestEventDataSchema,
  threadSchema,
  turnScope,
} from "@bb/domain";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

interface AgentThreadMessageTextArgs {
  messageText: string;
  senderThreadId: string;
}

interface LatestTurnRequestDataArgs {
  harness: TestAppHarness;
  threadId: string;
}

function agentThreadMessageText(args: AgentThreadMessageTextArgs): string {
  const prefix = `[bb message from thread:${args.senderThreadId}; reply with \`bb thread tell ${args.senderThreadId} "<your response>"\`]`;
  if (args.messageText.length === 0) {
    return prefix;
  }
  return [prefix, "", args.messageText].join("\n");
}

function latestTurnRequestData(
  args: LatestTurnRequestDataArgs,
): TurnRequestEventData {
  const requestedRows = listEvents(args.harness.db, {
    threadId: args.threadId,
  }).filter((row) => row.type === "client/turn/requested");
  const requestRow = requestedRows[requestedRows.length - 1];
  if (!requestRow) {
    throw new Error("Expected client/turn/requested event");
  }
  return turnRequestEventDataSchema.parse(JSON.parse(requestRow.data));
}

describe("public thread send and steer routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });

  it("rejects follow-up sends while a created thread is still starting", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-created-thread-send-rejected",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/created-thread-send-rejected",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/created-thread-send-rejected",
      });

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Initial start request" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      expect(createdThread.status).toBe("provisioning");

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Follow up before start completes" }],
            mode: "auto",
          }),
        },
      );

      expect(sendResponse.status).toBe(409);
      await expect(readJson(sendResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is still starting",
      });

      const requestedEvents = harness.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all()
        .filter((event) => event.type === "client/turn/requested");
      expect(requestedEvents).toHaveLength(1);

      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        status: "provisioning",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, queuedStart.row.id))
          .get(),
      ).toMatchObject({
        state: "pending",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues turn.submit for idle and active threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/send-project",
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: idleThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-idle",
        sequence: 1,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: idleThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-idle",
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 601 }),
          input: [{ type: "text", text: "Prior task" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-turn",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-turn",
        sequence: 4,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 602 }),
          input: [{ type: "text", text: "Prior task" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${idleThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Run this task" }],
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const runCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === idleThread.id,
      );
      expect(runCommand.command).toMatchObject({
        environmentId: environment.id,
        target: { mode: "start" },
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: idleThread.providerId,
          providerThreadId: "provider-idle",
        },
      });
      expect(getThread(harness.db, idleThread.id)?.status).toBe("active");

      const steerResponse = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Refocus the turn" }],
          }),
        },
      );
      expect(steerResponse.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === activeThread.id,
      );
      expect(steerCommand.command).toMatchObject({
        environmentId: environment.id,
        target: {
          mode: "steer",
          expectedTurnId: "turn-1",
        },
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: activeThread.providerId,
          providerThreadId: "provider-turn",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("formats sender-thread follow-ups with reply guidance", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/sender-thread-follow-up",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/sender-thread-follow-up",
      });
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const receiverThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: receiverThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-receiver-thread",
        sequenceStart: 10,
      });
      seedTurnStarted(harness.deps, {
        threadId: receiverThread.id,
        environmentId: environment.id,
        turnId: "turn-receiver-thread",
        providerThreadId: "provider-receiver-thread",
        sequence: 12,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${receiverThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            senderThreadId: senderThread.id,
            input: [{ type: "text", text: "Please review this result" }],
          }),
        },
      );
      expect(response.status).toBe(200);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === receiverThread.id,
      );
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      const firstInput = queued.command.input[0];
      if (firstInput?.type !== "text") {
        throw new Error("Expected text input");
      }

      const expectedText = agentThreadMessageText({
        messageText: "Please review this result",
        senderThreadId: senderThread.id,
      });
      expect(firstInput.text).toBe(expectedText);

      const requestData = latestTurnRequestData({
        harness,
        threadId: receiverThread.id,
      });
      expect(requestData.initiator).toBe("agent");
      expect(requestData.input).toEqual(queued.command.input);
      expect(requestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-receiver-thread",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("wraps sender-thread messages on the start path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/sender-thread-start",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/sender-thread-start",
      });
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const receiverThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${receiverThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "start",
            model: "gpt-5",
            senderThreadId: senderThread.id,
            input: [{ type: "text", text: "Start from this context" }],
          }),
        },
      );
      expect(response.status).toBe(200);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === receiverThread.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected thread.start command");
      }
      const expectedInput: PromptInput[] = [
        {
          type: "text",
          text: agentThreadMessageText({
            messageText: "Start from this context",
            senderThreadId: senderThread.id,
          }),
        },
      ];

      expect(queued.command.input).toEqual(expectedInput);
      const requestData = latestTurnRequestData({
        harness,
        threadId: receiverThread.id,
      });
      expect(requestData.initiator).toBe("agent");
      expect(requestData.input).toEqual(expectedInput);
      expect(requestData.target).toEqual({ kind: "new-turn" });
    } finally {
      await harness.cleanup();
    }
  });

  it("wraps sender-thread messages on the steer path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/sender-thread-steer",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/sender-thread-steer",
      });
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const receiverThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: receiverThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-receiver-steer",
        sequenceStart: 20,
      });
      seedTurnStarted(harness.deps, {
        threadId: receiverThread.id,
        environmentId: environment.id,
        turnId: "turn-receiver-steer",
        providerThreadId: "provider-receiver-steer",
        sequence: 22,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${receiverThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            senderThreadId: senderThread.id,
            input: [{ type: "text", text: "Adjust the active turn" }],
          }),
        },
      );
      expect(response.status).toBe(200);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === receiverThread.id,
      );
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      const expectedInput: PromptInput[] = [
        {
          type: "text",
          text: agentThreadMessageText({
            messageText: "Adjust the active turn",
            senderThreadId: senderThread.id,
          }),
        },
      ];

      expect(queued.command.input).toEqual(expectedInput);
      expect(queued.command.target).toEqual({
        mode: "steer",
        expectedTurnId: "turn-receiver-steer",
      });
      const requestData = latestTurnRequestData({
        harness,
        threadId: receiverThread.id,
      });
      expect(requestData.initiator).toBe("agent");
      expect(requestData.input).toEqual(expectedInput);
      expect(requestData.target).toEqual({
        kind: "steer",
        expectedTurnId: "turn-receiver-steer",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid or deleted sender-thread metadata", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/sender-thread-invalid",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/sender-thread-invalid",
      });
      const receiverThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const invalidResponse = await harness.app.request(
        `/api/v1/threads/${receiverThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "start",
            senderThreadId: "thr_missing_sender",
            input: [{ type: "text", text: "Should fail" }],
          }),
        },
      );
      expect(invalidResponse.status).toBe(400);
      await expect(readJson(invalidResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "senderThreadId must reference a live thread",
      });

      const deletedSenderThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      markThreadDeleted(harness.db, harness.hub, {
        threadId: deletedSenderThread.id,
        deletedAt: 123,
      });

      const deletedResponse = await harness.app.request(
        `/api/v1/threads/${receiverThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "start",
            senderThreadId: deletedSenderThread.id,
            input: [{ type: "text", text: "Should also fail" }],
          }),
        },
      );
      expect(deletedResponse.status).toBe(400);
      await expect(readJson(deletedResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "senderThreadId must reference a live thread",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("formats sender-thread non-text input cases explicitly", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/sender-thread-non-text",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/sender-thread-non-text",
      });
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const imageOnlyThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const mixedInputThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: imageOnlyThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-image-only",
        sequenceStart: 30,
      });
      seedTurnStarted(harness.deps, {
        threadId: imageOnlyThread.id,
        environmentId: environment.id,
        turnId: "turn-image-only",
        providerThreadId: "provider-image-only",
        sequence: 32,
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: mixedInputThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-mixed-input",
        sequenceStart: 40,
      });
      seedTurnStarted(harness.deps, {
        threadId: mixedInputThread.id,
        environmentId: environment.id,
        turnId: "turn-mixed-input",
        providerThreadId: "provider-mixed-input",
        sequence: 42,
      });

      const imageOnlyInput: PromptInput[] = [
        {
          type: "image",
          url: "https://example.com/image-only.png",
        },
      ];
      const imageOnlyResponse = await harness.app.request(
        `/api/v1/threads/${imageOnlyThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            senderThreadId: senderThread.id,
            input: imageOnlyInput,
          }),
        },
      );
      expect(imageOnlyResponse.status).toBe(200);

      const imageOnlyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === imageOnlyThread.id,
      );
      if (imageOnlyCommand.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      const expectedImageOnlyInput: PromptInput[] = [
        {
          type: "text",
          text: agentThreadMessageText({
            messageText: "",
            senderThreadId: senderThread.id,
          }),
        },
        {
          type: "image",
          url: "https://example.com/image-only.png",
        },
      ];
      expect(imageOnlyCommand.command.input).toEqual(expectedImageOnlyInput);
      const imageOnlyRequestData = latestTurnRequestData({
        harness,
        threadId: imageOnlyThread.id,
      });
      expect(imageOnlyRequestData.initiator).toBe("agent");
      expect(imageOnlyRequestData.input).toEqual(expectedImageOnlyInput);

      const mixedInput: PromptInput[] = [
        {
          type: "image",
          url: "https://example.com/context.png",
        },
        {
          type: "text",
          text: "Use this visual context",
        },
      ];
      const mixedResponse = await harness.app.request(
        `/api/v1/threads/${mixedInputThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            senderThreadId: senderThread.id,
            input: mixedInput,
          }),
        },
      );
      expect(mixedResponse.status).toBe(200);

      const mixedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === mixedInputThread.id,
      );
      if (mixedCommand.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      const expectedMixedInput: PromptInput[] = [
        {
          type: "image",
          url: "https://example.com/context.png",
        },
        {
          type: "text",
          text: agentThreadMessageText({
            messageText: "Use this visual context",
            senderThreadId: senderThread.id,
          }),
        },
      ];
      expect(mixedCommand.command.input).toEqual(expectedMixedInput);
      const mixedRequestData = latestTurnRequestData({
        harness,
        threadId: mixedInputThread.id,
      });
      expect(mixedRequestData.initiator).toBe("agent");
      expect(mixedRequestData.input).toEqual(expectedMixedInput);
    } finally {
      await harness.cleanup();
    }
  });

  it("queues explicit stale steer for daemon fallback to a new turn", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/send-without-open-turn",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-closed-turn",
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 701 }),
          input: [{ type: "text", text: "Prior task" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-closed-turn",
        scope: turnScope("turn-closed"),
        sequence: 2,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-closed-turn",
        scope: turnScope("turn-closed"),
        sequence: 3,
        type: "turn/completed",
        data: { status: "completed" },
      });

      const steerResponse = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Do not attach to old turn" }],
          }),
        },
      );

      expect(steerResponse.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === activeThread.id,
      );
      expect(steerCommand.command).toMatchObject({
        target: {
          mode: "steer",
          expectedTurnId: null,
        },
      });
      const threadEvents = harness.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.threadId, activeThread.id))
        .orderBy(events.sequence)
        .all();
      expect(threadEvents.map((event) => event.type)).toEqual([
        "client/turn/requested",
        "turn/started",
        "turn/completed",
        "client/turn/requested",
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid send mode transitions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const startOnActive = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "start",
            input: [{ type: "text", text: "Should fail" }],
          }),
        },
      );
      expect(startOnActive.status).toBe(409);
      await expect(readJson(startOnActive)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is already active",
      });

      const steerOnIdle = await harness.app.request(
        `/api/v1/threads/${idleThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Should also fail" }],
          }),
        },
      );
      expect(steerOnIdle.status).toBe(409);
      await expect(readJson(steerOnIdle)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is not active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("steers queued drafts for active threads without a mode field", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-draft-steer-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-draft-steer-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-steer",
        sequence: 1,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-steer",
        sequence: 2,
        type: "turn/started",
        data: {},
        scope: turnScope("turn-draft-steer"),
      });
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queue a correction" }],
        model: "gpt-5",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(steerCommand.command).toMatchObject({
        input: [{ type: "text", text: "Queue a correction" }],
        target: {
          mode: "auto",
          expectedTurnId: "turn-draft-steer",
        },
        options: {
          model: "gpt-5",
        },
        resumeContext: {
          providerThreadId: "provider-draft-steer",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("sends queued drafts with explicit steer mode", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-draft-explicit-steer-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-draft-explicit-steer-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-explicit-steer",
        sequence: 1,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-explicit-steer",
        sequence: 2,
        type: "turn/started",
        data: {},
        scope: turnScope("turn-draft-explicit-steer"),
      });
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Steer this queued correction" }],
        model: "gpt-5",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "steer" }),
        },
      );

      expect(response.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(steerCommand.command).toMatchObject({
        input: [{ type: "text", text: "Steer this queued correction" }],
        target: {
          mode: "steer",
          expectedTurnId: "turn-draft-explicit-steer",
        },
        options: {
          model: "gpt-5",
        },
        resumeContext: {
          providerThreadId: "provider-draft-explicit-steer",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
