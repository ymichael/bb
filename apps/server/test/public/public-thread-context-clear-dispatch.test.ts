import {
  createQueuedThreadMessage,
  getLastStoredProviderThreadId,
  listQueuedThreadMessages,
} from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mentions from "../../src/services/plugins/plugin-mentions.js";
import * as commands from "../../src/services/threads/thread-commands.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.restoreAllMocks());

function seedFixture(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "codex",
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-before-clear",
    threadId: thread.id,
  });
  return { host, session, thread };
}

function registerResponder(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedFixture>,
  stop: () => Promise<void>,
) {
  return registerHostRpcResponder(harness, {
    hostId: fixture.host.id,
    sessionId: fixture.session.id,
    handle: async ({ command }) => {
      switch (command.type) {
        case "thread.stop":
          await stop();
          return { ok: true, result: { providerCheckpointId: null } };
        case "thread.start":
          return {
            ok: true,
            result: { providerThreadId: "provider-after-clear" },
          };
        case "turn.submit":
          return { ok: true, result: { appliedAs: "new-turn" } };
        case "host.list_files":
          return { ok: true, result: { files: [], truncated: false } };
        case "host.read_file":
          return { ok: false, errorCode: "ENOENT", errorMessage: "Missing" };
        default:
          throw new Error(`Unexpected command: ${command.type}`);
      }
    },
  });
}

describe("context clear dispatch races", () => {
  it.each(["queue", "parent notice"] as const)(
    "rejects clear while a %s is preparing a turn",
    async (source) => {
      await withTestHarness(async (harness) => {
        const fixture = seedFixture(harness);
        const { thread } = fixture;
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const responder = registerResponder(harness, fixture, async () => {});
        if (source === "queue") {
          seedQueuedMessage(harness.deps, {
            threadId: thread.id,
            content: textInput("Queued follow-up"),
          });
          vi.spyOn(
            mentions,
            "resolvePluginMentionContextInputs",
          ).mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [];
          });
        } else {
          const buildExecutionOptions = commands.buildExecutionOptions;
          vi.spyOn(commands, "buildExecutionOptions").mockImplementationOnce(
            async (...args) => {
              entered.resolve();
              await release.promise;
              return buildExecutionOptions(...args);
            },
          );
        }
        const sending =
          source === "queue"
            ? sendNextQueuedMessageIfPresent(harness.deps, {
                threadId: thread.id,
              })
            : queueParentSystemMessage(harness.deps, {
                parentThreadId: thread.id,
                input: textInput("Child completed"),
                systemMessageKind: "child-completed",
                systemMessageSubject: null,
              });
        try {
          await entered.promise;
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}/context/clear`,
            { method: "POST" },
          );
          expect(response.status).toBe(409);
          expect(getLastStoredProviderThreadId(harness.db, thread.id)).toBe(
            "provider-before-clear",
          );
          expect(responder.requests).not.toContainEqual(
            expect.objectContaining({
              command: expect.objectContaining({ type: "thread.stop" }),
            }),
          );
        } finally {
          release.resolve();
          await sending;
        }
        await vi.waitFor(() => {
          expect(
            responder.requests.some(
              ({ command }) => command.type === "turn.submit",
            ),
          ).toBe(true);
        });
      });
    },
  );

  it.each(["message", "queued notice", "new notice"] as const)(
    "retains a %s during clear and dispatches it into a fresh session afterward",
    async (source) => {
      await withTestHarness(async (harness) => {
        const fixture = seedFixture(harness);
        const { thread } = fixture;
        const stopping = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const responder = registerResponder(harness, fixture, async () => {
          stopping.resolve();
          await release.promise;
        });
        if (source !== "new notice") {
          createQueuedThreadMessage(harness.db, harness.hub, {
            threadId: thread.id,
            content: textInput("Follow-up after clear"),
            senderThreadId: null,
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            waitingOn: { kind: "thread-busy" },
            sendAt: null,
            payload: { kind: "inline" },
            systemNotice:
              source === "queued notice"
                ? { kind: "child-completed", subject: null }
                : null,
          });
        }
        const clearing = harness.app.request(
          `/api/v1/threads/${thread.id}/context/clear`,
          { method: "POST" },
        );
        try {
          await stopping.promise;
          if (source === "new notice") {
            await expect(
              queueParentSystemMessage(harness.deps, {
                parentThreadId: thread.id,
                input: textInput("Child completed during clear"),
                systemMessageKind: "child-completed",
                systemMessageSubject: null,
              }),
            ).resolves.toBe(true);
          }
          await expect(
            sendNextQueuedMessageIfPresent(harness.deps, {
              threadId: thread.id,
            }),
          ).resolves.toBe(false);
          expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([
            expect.objectContaining({ claimedAt: null, failureReason: null }),
          ]);
          expect(
            responder.requests.filter(
              ({ command }) =>
                command.type === "turn.submit" ||
                command.type === "thread.start",
            ),
          ).toEqual([]);
        } finally {
          release.resolve();
          expect((await clearing).status).toBe(200);
        }
        await vi.waitFor(() => {
          expect(
            responder.requests.filter(
              ({ command }) => command.type === "thread.start",
            ),
          ).toHaveLength(1);
          expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        });
        expect(
          responder.requests.filter(
            ({ command }) => command.type === "turn.submit",
          ),
        ).toEqual([]);
      });
    },
  );
});
