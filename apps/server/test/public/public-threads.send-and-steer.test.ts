import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  events,
  getDraft,
  getThread,
  hostDaemonCommands,
  threads,
} from "@bb/db";
import { threadSchema } from "@bb/domain";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";

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
          command.type === "thread.start"
          && command.threadId === createdThread.id,
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
        .where(
          eq(events.threadId, createdThread.id),
        )
        .all()
        .filter((event) => event.type === "client/turn/requested");
      expect(requestedEvents).toHaveLength(0);

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


  it("queues turn.run for idle threads and turn.steer for active threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: idleThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-idle",
        sequence: 2,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Prior task" }],
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
        turnId: "turn-1",
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
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Prior task" }],
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
          command.type === "turn.run" && command.threadId === idleThread.id,
      );
      expect(runCommand.command).toMatchObject({
        environmentId: environment.id,
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: environment.path, workspaceProvisionType: "unmanaged" },
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
          command.type === "turn.steer" && command.threadId === activeThread.id,
      );
      expect(steerCommand.command).toMatchObject({
        expectedTurnId: "turn-1",
        environmentId: environment.id,
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: environment.path, workspaceProvisionType: "unmanaged" },
          projectId: project.id,
          providerId: activeThread.providerId,
          providerThreadId: "provider-turn",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("does not steer a thread whose latest provider turn is already closed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
        turnId: "turn-closed",
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-closed-turn",
        turnId: "turn-closed",
        sequence: 2,
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

      expect(steerResponse.status).toBe(409);
      await expect(readJson(steerResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "No active turn to steer",
      });
      const threadEvents = harness.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.threadId, activeThread.id))
        .orderBy(events.sequence)
        .all();
      expect(threadEvents.map((event) => event.type)).toEqual([
        "turn/started",
        "turn/completed",
      ]);
    } finally {
      await harness.cleanup();
    }
  });


  it("rejects invalid send mode transitions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-steer",
        sequence: 2,
        type: "turn/started",
        data: {},
        turnId: "turn-draft-steer",
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
          command.type === "turn.steer" && command.threadId === thread.id,
      );
      expect(steerCommand.command).toMatchObject({
        expectedTurnId: "turn-draft-steer",
        input: [{ type: "text", text: "Queue a correction" }],
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
});
