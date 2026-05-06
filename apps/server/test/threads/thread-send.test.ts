import { describe, expect, it } from "vitest";
import { hostDaemonCommands, listEvents } from "@bb/db";
import { ApiError } from "../../src/errors.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("sendThreadMessage", () => {
  it("rejects user sends while the thread is awaiting interaction", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-thread-send-awaiting-interaction",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-send-blocked",
        providerThreadId: "provider-thread-send-blocked",
      });

      const registered = harness.deps.pendingInteractions.registerPendingInteraction(
        {
          interaction: {
            threadId: thread.id,
            turnId: "turn-send-blocked",
            providerId: thread.providerId,
            providerThreadId: "provider-thread-send-blocked",
            providerRequestId: "request-send-blocked",
            payload: createCommandApprovalPayload(),
          },
          sessionId: session.id,
        },
      );
      expect(registered.outcome).toBe("created");

      await expect(
        sendThreadMessage(harness.deps, {
          environment,
          payload: {
            input: [{ type: "text", text: "blocked user send" }],
            mode: "auto",
            model: "gpt-5.4",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
          trigger: "user",
        }),
      ).rejects.toMatchObject<ApiError>({
        status: 409,
        body: {
          code: "awaiting_user_interaction",
        },
      });

      expect(harness.db.select().from(hostDaemonCommands).all()).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("allows queued auto-dispatch while the thread is awaiting interaction", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-thread-send-auto-dispatch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-send-auto-dispatch",
        providerThreadId: "provider-thread-send-auto-dispatch",
      });

      const registered = harness.deps.pendingInteractions.registerPendingInteraction(
        {
          interaction: {
            threadId: thread.id,
            turnId: "turn-send-auto-dispatch",
            providerId: thread.providerId,
            providerThreadId: "provider-thread-send-auto-dispatch",
            providerRequestId: "request-send-auto-dispatch",
            payload: createCommandApprovalPayload(),
          },
          sessionId: session.id,
        },
      );
      expect(registered.outcome).toBe("created");

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: [{ type: "text", text: "auto dispatch send" }],
          mode: "auto",
          model: "gpt-5.4",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "auto-dispatch",
      });

      const queuedCommands = harness.db.select().from(hostDaemonCommands).all();
      expect(queuedCommands).toHaveLength(1);
      expect(["thread.start", "turn.submit"]).toContain(
        queuedCommands[0]?.type,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects active-thread sends while the host is unavailable before appending a client event", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-thread-send-waiting-for-host",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      await expect(
        sendThreadMessage(harness.deps, {
          environment,
          payload: {
            input: [{ type: "text", text: "should not append" }],
            mode: "auto",
            model: "gpt-5.4",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
          trigger: "user",
        }),
      ).rejects.toMatchObject<ApiError>({
        status: 502,
        body: {
          code: "host_disconnected",
        },
      });

      expect(harness.db.select().from(hostDaemonCommands).all()).toEqual([]);
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
