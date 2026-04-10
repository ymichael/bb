import { eq } from "drizzle-orm";
import { events, getThread, queueCommand } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  internalAuthHeaders,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("thread command failure side effects", () => {
  it("transitions thread to error when thread.start fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-start-fail",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.start",
        payload: JSON.stringify({
          type: "thread.start",
          environmentId: environment.id,
          threadId: thread.id,
          workspaceContext: {
            workspacePath: "/tmp/test",
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: "codex",
          eventSequence: 1,
          input: [{ type: "text", text: "Hello" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            questionPolicy: "allow",
          },
          instructions: "You are a helpful assistant.",
          dynamicTools: [],
          instructionMode: "append",
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "invalid_request",
        errorMessage: "Unsupported service_tier: flex",
      });
      expect(response.status).toBe(200);

      const updated = getThread(harness.db, thread.id);
      expect(updated?.status).toBe("error");

      const errorEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((e) => e.type === "system/error");
      expect(errorEvents).toHaveLength(1);
      expect(JSON.parse(errorEvents[0]!.data)).toMatchObject({
        code: "thread_command_failed",
        message: "Command thread.start failed",
        detail: "Unsupported service_tier: flex",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("transitions thread to error when turn.run fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-turn-fail",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "turn.run",
        payload: JSON.stringify({
          type: "turn.run",
          environmentId: environment.id,
          threadId: thread.id,
          eventSequence: 1,
          input: [{ type: "text", text: "Continue" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            questionPolicy: "allow",
          },
          resumeContext: {
            workspaceContext: {
              workspacePath: "/tmp/test",
              workspaceProvisionType: "unmanaged",
            },
            projectId: project.id,
            providerId: "codex",
            providerThreadId: "provider-thread-1",
            instructions: "You are a helpful assistant.",
            dynamicTools: [],
            instructionMode: "append",
          },
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider process crashed",
      });
      expect(response.status).toBe(200);

      const updated = getThread(harness.db, thread.id);
      expect(updated?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not transition thread when a successful thread.start is reported", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-start-ok",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.start",
        payload: JSON.stringify({
          type: "thread.start",
          environmentId: environment.id,
          threadId: thread.id,
          workspaceContext: {
            workspacePath: "/tmp/test",
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: "codex",
          eventSequence: 1,
          input: [{ type: "text", text: "Hello" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            questionPolicy: "allow",
          },
          instructions: "You are a helpful assistant.",
          dynamicTools: [],
          instructionMode: "append",
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      // Report success — thread.start result is empty
      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: queued.row.id,
            completedAt: Date.now(),
            type: "thread.start",
            ok: true,
            result: { providerThreadId: "provider-thread-1" },
          }),
        },
      );
      expect(response.status).toBe(200);

      const updated = getThread(harness.db, thread.id);
      expect(updated?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });
});
