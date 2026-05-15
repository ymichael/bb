import { describe, expect, it } from "vitest";
import { hostDaemonCommands, listEvents } from "@bb/db";
import type { PromptInput } from "@bb/domain";
import { sendQueuedMessage } from "../../src/services/threads/queued-messages.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { assertPromptHistoryForTurnRequest } from "../helpers/prompt-history.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

interface ActiveSendPromptHistoryCase {
  input: PromptInput[];
  label: string;
  mode: "auto" | "steer";
  providerThreadId: string;
  turnId: string;
}

const activeSendPromptHistoryCases: ActiveSendPromptHistoryCase[] = [
  {
    input: [{ type: "text", text: "continue active work" }],
    label: "auto",
    mode: "auto",
    providerThreadId: "provider-thread-send-auto-history",
    turnId: "turn-send-auto-history",
  },
  {
    input: [{ type: "text", text: "adjust active work" }],
    label: "steer",
    mode: "steer",
    providerThreadId: "provider-thread-send-steer-history",
    turnId: "turn-send-steer-history",
  },
];

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

      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-send-blocked",
            providerId: thread.providerId,
            providerThreadId: "provider-thread-send-blocked",
            providerRequestId: "request-send-blocked",
            payload: createCommandApprovalPayload(),
          },
          sessionId: session.id,
        });
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
      ).rejects.toMatchObject({
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

  it("records thread prompt history for start sends on idle threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-send-start-history",
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
        status: "idle",
      });
      const input: PromptInput[] = [{ type: "text", text: "start idle work" }];

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input,
          mode: "start",
          model: "gpt-5.4",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });

      assertPromptHistoryForTurnRequest({
        db: harness.db,
        threadId: thread.id,
        scope: "thread",
        input,
      });
      expect(
        harness.db
          .select({ type: hostDaemonCommands.type })
          .from(hostDaemonCommands)
          .all()
          .map((command) => command.type),
      ).toContain("thread.start");
    } finally {
      await harness.cleanup();
    }
  });

  it.each(activeSendPromptHistoryCases)(
    "records thread prompt history for $label sends on active threads",
    async ({ input, mode, providerThreadId, turnId }) => {
      const harness = await createTestAppHarness();
      try {
        const { host } = seedHostSession(harness.deps, {
          id: `host-thread-send-${mode}-history`,
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
        seedThreadRuntimeState(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId,
        });
        seedTurnStarted(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          turnId,
          providerThreadId,
        });

        await sendThreadMessage(harness.deps, {
          environment,
          payload: {
            input,
            mode,
            model: "gpt-5.4",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
          trigger: "user",
        });

        assertPromptHistoryForTurnRequest({
          db: harness.db,
          threadId: thread.id,
          scope: "thread",
          input,
        });
        expect(
          harness.db
            .select({ type: hostDaemonCommands.type })
            .from(hostDaemonCommands)
            .all()
            .map((command) => command.type),
        ).toContain("turn.submit");
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("records thread prompt history for idle queued message auto-sends", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-send-queued-message-history",
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
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-send-queued-message-history",
      });
      const input: PromptInput[] = [
        { type: "text", text: "send queued message" },
      ];
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: input,
      });

      await sendQueuedMessage(harness.deps, {
        mode: "auto",
        queuedMessageId: queuedMessage.id,
        threadId: thread.id,
      });

      assertPromptHistoryForTurnRequest({
        db: harness.db,
        threadId: thread.id,
        scope: "thread",
        input,
      });
      expect(
        harness.db
          .select({ type: hostDaemonCommands.type })
          .from(hostDaemonCommands)
          .all()
          .map((command) => command.type),
      ).toContain("turn.submit");
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

      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-send-auto-dispatch",
            providerId: thread.providerId,
            providerThreadId: "provider-thread-send-auto-dispatch",
            providerRequestId: "request-send-auto-dispatch",
            payload: createCommandApprovalPayload(),
          },
          sessionId: session.id,
        });
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
      ).rejects.toMatchObject({
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
