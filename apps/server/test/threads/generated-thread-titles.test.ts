import { createThread, getThread, listEvents } from "@bb/db";
import {
  type ResolvedThreadExecutionOptions,
  systemThreadProvisioningEventDataSchema,
  threadSchema,
  turnScope,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";
import { AiServiceCallError } from "../../src/services/ai/ai-service-call.js";
import { InferenceTimeoutError } from "../../src/services/ai/inference.js";
import { runEnvironmentProvisioningSweep } from "../../src/services/system/periodic-sweeps.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { requestThreadStopForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import {
  advanceThreadProvisioning,
  requestThreadProvision,
} from "../../src/services/threads/thread-provisioning.js";
import { generateThreadMetadataWithOutcome } from "../../src/services/threads/title-generation.js";

const piAiMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  getModel: vi.fn(),
}));

interface MockThreadMetadata {
  title?: string;
}

function mockThreadMetadataCompletion(metadata: MockThreadMetadata) {
  return {
    content: [
      {
        arguments: metadata,
        id: "tool_result",
        name: "result",
        type: "toolCall",
      },
    ],
  };
}

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    complete: piAiMocks.complete,
    getModel: piAiMocks.getModel,
    getProviders: () => [],
  }),
}));

function mockThreadMetadata(metadata: MockThreadMetadata): void {
  piAiMocks.getModel.mockReturnValue({ provider: "test" });
  piAiMocks.complete.mockResolvedValue(mockThreadMetadataCompletion(metadata));
}

function pendingThreadMetadata(): (metadata: MockThreadMetadata) => void {
  let resolveMetadata: (metadata: MockThreadMetadata) => void = () => {
    throw new Error("Metadata inference was not started");
  };
  piAiMocks.getModel.mockReturnValue({ provider: "test" });
  piAiMocks.complete.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveMetadata = (metadata) => {
          resolve(mockThreadMetadataCompletion(metadata));
        };
      }),
  );
  return (metadata) => {
    resolveMetadata(metadata);
  };
}

const THREAD_START_EXECUTION = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} satisfies ResolvedThreadExecutionOptions;

interface CreateManagedWorktreeThreadArgs {
  hostId: string;
  projectId: string;
  text: string;
  title?: string;
}

async function createManagedWorktreeThread(
  harness: TestAppHarness,
  args: CreateManagedWorktreeThreadArgs,
) {
  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: "app",
      projectId: args.projectId,
      providerId: "codex",
      model: "gpt-5",
      ...(args.title === undefined ? {} : { title: args.title }),
      input: [{ type: "text", text: args.text }],
      environment: {
        type: "host",
        hostId: args.hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    }),
  });
  expect(response.status).toBe(201);
  return threadSchema.parse(await readJson(response));
}

function provisioningEntries(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/thread-provisioning")
    .flatMap(
      (event) =>
        systemThreadProvisioningEventDataSchema.parse(JSON.parse(event.data))
          .entries,
    );
}

describe("generated thread titles", () => {
  beforeEach(() => {
    piAiMocks.complete.mockReset();
    piAiMocks.getModel.mockReset();
  });

  it("resolves a managed-worktree request to the worktree provider once the title is generated", async () => {
    mockThreadMetadata({ title: "Improve Branch Names" });
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-branch-project",
      });

      const thread = await createManagedWorktreeThread(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Improve the generated branch naming path",
      });
      expect(thread.title).toBeNull();

      const context = await provider.waitForProvision();
      expect(context.thread.id).toBe(thread.id);
      expect(context.thread.title).toBe("Improve Branch Names");
      expect(context.host?.id).toBe(host.id);
      expect(context.inputs).toEqual({ branch: { kind: "default" } });
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Improve Branch Names",
      );
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
    });
  });

  it("opens the workspace-setup block before metadata inference completes", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-early-provisioning-row",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-early-provisioning-row-project",
      });

      const thread = await createManagedWorktreeThread(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Show provisioning before generated branch metadata finishes",
      });

      await vi.waitFor(() => {
        expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
        expect(provisioningEntries(harness, thread.id)[0]?.key).toBe(
          "workspace-started",
        );
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(provider.contexts).toHaveLength(0);

      resolveMetadata({ title: "Early Visible Provisioning" });

      const context = await provider.waitForProvision();
      expect(context.thread.title).toBe("Early Visible Provisioning");
    });
  });

  it("does not fail a stopped thread when metadata inference settles", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-stop-during-metadata",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stop-during-metadata-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "starting",
        title: null,
        titleFallback: "Stop during metadata inference",
      });
      const input = textInput("Stop during metadata inference before setup");
      const context = requestThreadProvision(harness.deps, {
        environmentIntent: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: host.id },
          inputs: { branch: { kind: "default" } },
          selectionResolved: true,
          produced: null,
        },
        execution: THREAD_START_EXECUTION,
        fork: null,
        input,
        startedOnBehalfOf: null,
        thread,
        titleProvided: false,
      });
      const advance = advanceThreadProvisioning(harness.deps, {
        context,
        threadId: thread.id,
      });

      await vi.waitFor(() => {
        expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
      });

      const startingThread = getThread(harness.db, thread.id);
      if (!startingThread) {
        throw new Error("Expected the starting thread");
      }
      expect(startingThread.environmentId).toBeNull();
      requestThreadStopForCurrentState(harness.deps, startingThread, null);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });

      resolveMetadata({ title: "Stopped Metadata Race" });
      await advance;

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      const events = listEvents(harness.db, { threadId: thread.id });
      expect(events.map((event) => event.type)).not.toContain("system/error");
      expect(provider.contexts).toHaveLength(0);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
    });
  });

  it("does not fail a thread waiting on metadata during provisioning sweeps", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-prepared-sweep",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-prepared-sweep-project",
      });

      const thread = await createManagedWorktreeThread(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Keep prepared provisioning safe during sweeps",
      });

      await vi.waitFor(() => {
        expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
        expect(provisioningEntries(harness, thread.id)).not.toHaveLength(0);
      });

      await runEnvironmentProvisioningSweep(harness.deps);

      expect(getThread(harness.db, thread.id)?.status).toBe("starting");
      expect(
        listEvents(harness.db, { threadId: thread.id }).map(
          (event) => event.type,
        ),
      ).not.toContain("system/error");

      resolveMetadata({ title: "Prepared Sweep Safe" });

      const context = await provider.waitForProvision();
      expect(context.thread.title).toBe("Prepared Sweep Safe");
    });
  });

  it("uses two timeout attempts for provider-path metadata inference", async () => {
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete
      .mockRejectedValueOnce(new InferenceTimeoutError({ timeoutMs: 2_500 }))
      .mockResolvedValueOnce(
        mockThreadMetadataCompletion({
          title: "Recovered Managed Metadata",
        }),
      );
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-metadata-retry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-metadata-retry-project",
      });

      const thread = await createManagedWorktreeThread(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Recover managed metadata after transient timeout",
      });

      const context = await provider.waitForProvision();
      expect(context.thread.title).toBe("Recovered Managed Metadata");
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Recovered Managed Metadata",
      );
      expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
    });
  });

  it("queues a daemon rename after a generated title thread starts", async () => {
    mockThreadMetadata({ title: "Generated Rename Title" });
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-title-rename",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-title-rename-project",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/generated-title-rename-workspace",
        status: "ready",
      });
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: "/tmp/generated-title-rename-workspace",
        },
      }));

      const thread = await createManagedWorktreeThread(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Generate a title then sync it after startup",
      });
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-generated-title-rename" },
        { hostId: host.id },
      );

      const rename = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "thread.rename" && command.threadId === thread.id,
      );
      expect(rename.command).toMatchObject({
        type: "thread.rename",
        threadId: thread.id,
        title: "Generated Rename Title",
      });
    });
  });

  it("generates titles for submitted fork threads", async () => {
    mockThreadMetadata({ title: "Generated Fork Title" });

    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-fork-title",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-fork-title-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/generated-fork-title-project",
        status: "ready",
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: sourceThread.id,
        turnId: "turn-generated-fork-title-source",
        providerThreadId: "provider-generated-fork-title-source",
      });

      const input = textInput("Continue this fork and generate a useful title");
      const fork = await createThreadFromRequest(harness.deps, {
        environment: { type: "reuse", environmentId: environment.id },
        input,
        model: "gpt-5",
        origin: "app",
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceThread.id,
        startedOnBehalfOf: null,
      });

      expect(getThread(harness.db, fork.id)?.titleFallback).toBe(
        "Continue this fork and generate a useful title",
      );

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(start.command.input).toEqual(input);
      expect(start.command.fork).toEqual({
        sourceProviderThreadId: "provider-generated-fork-title-source",
      });

      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-generated-fork-title" },
        { hostId: host.id },
      );

      await vi.waitFor(() => {
        expect(getThread(harness.db, fork.id)?.title).toBe(
          "Generated Fork Title",
        );
      });
    });
  });
  it("does not queue a daemon rename for user-supplied titles", async () => {
    mockThreadMetadata({ title: "Generated Title" });
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-user-title-no-rename",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/user-title-no-rename-project",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/user-title-no-rename-workspace",
        status: "ready",
      });
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: "/tmp/user-title-no-rename-workspace",
        },
      }));

      const thread = await createManagedWorktreeThread(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Use the user supplied title without daemon rename",
        title: "User Picked Title",
      });
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-user-title-no-rename" },
        { hostId: host.id },
      );

      await expect(
        waitForQueuedCommandAfter(
          harness,
          start.row.cursor,
          ({ command }) =>
            command.type === "thread.rename" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      expect(piAiMocks.complete).not.toHaveBeenCalled();
    });
  });

  it("uses the fallback model and renames an idle non-managed thread", async () => {
    let resolveMetadata: (metadata: MockThreadMetadata) => void = () => {
      throw new Error("Metadata inference was not started");
    };
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete
      .mockRejectedValueOnce(
        new AiServiceCallError(
          "codex",
          "service_unavailable",
          "Our servers are currently overloaded. Please try again later.",
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMetadata = (metadata) => {
              resolve(mockThreadMetadataCompletion(metadata));
            };
          }),
      );

    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-idle-late-title-rename",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/idle-late-title-rename-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/idle-late-title-rename-workspace",
        status: "ready",
      });
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "starting",
        title: null,
        titleFallback: "Idle late title rename",
      });

      const context = requestThreadProvision(harness.deps, {
        environmentIntent: {
          type: "reuse",
          environmentId: environment.id,
        },
        execution: THREAD_START_EXECUTION,
        fork: null,
        input: textInput("Generate a title for this non-managed reuse thread"),
        startedOnBehalfOf: null,
        thread,
        titleProvided: false,
      });
      await advanceThreadProvisioning(harness.deps, {
        context,
        threadId: thread.id,
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-idle-late-title" },
        { hostId: host.id },
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(getThread(harness.db, thread.id)?.title).toBeNull();

      const eventsResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              {
                threadId: thread.id,
                event: {
                  type: "turn/started",
                  threadId: thread.id,
                  providerThreadId: "provider-idle-late-title",
                  scope: turnScope("turn-idle-late-title"),
                },
              },
              {
                threadId: thread.id,
                event: {
                  type: "turn/completed",
                  threadId: thread.id,
                  providerThreadId: "provider-idle-late-title",
                  scope: turnScope("turn-idle-late-title"),
                  status: "completed",
                },
              },
            ]),
          }),
        },
      );
      expect(eventsResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");

      await vi.waitFor(() => {
        expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
      });

      resolveMetadata({ title: "Late Idle Title" });

      const rename = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "thread.rename" && command.threadId === thread.id,
      );
      expect(rename.command).toMatchObject({
        type: "thread.rename",
        threadId: thread.id,
        title: "Late Idle Title",
      });
      expect(getThread(harness.db, thread.id)?.title).toBe("Late Idle Title");
      expect(piAiMocks.getModel).toHaveBeenNthCalledWith(
        1,
        "test",
        "mock-model",
      );
      expect(piAiMocks.getModel).toHaveBeenNthCalledWith(
        2,
        "test",
        "mock-fallback-model",
      );
    });
  });

  it("does not rename a non-managed thread that errored before its title landed", async () => {
    let resolveMetadata: (metadata: MockThreadMetadata) => void = () => {
      throw new Error("Metadata inference was not started");
    };
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = (metadata) => {
            resolve(mockThreadMetadataCompletion(metadata));
          };
        }),
    );

    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-errored-late-title-no-rename",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/errored-late-title-no-rename-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/errored-late-title-no-rename-workspace",
        status: "ready",
      });
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "starting",
        title: null,
        titleFallback: "Errored late title no rename",
      });

      const context = requestThreadProvision(harness.deps, {
        environmentIntent: {
          type: "reuse",
          environmentId: environment.id,
        },
        execution: THREAD_START_EXECUTION,
        fork: null,
        input: textInput("Generate a title for this non-managed reuse thread"),
        startedOnBehalfOf: null,
        thread,
        titleProvided: false,
      });
      await advanceThreadProvisioning(harness.deps, {
        context,
        threadId: thread.id,
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      await reportQueuedCommandError(
        harness,
        start,
        {
          errorCode: "thread_start_failed",
          errorMessage: "Thread start failed",
        },
        { hostId: host.id },
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("error");

      resolveMetadata({ title: "Errored Late Title" });

      await expect(
        waitForQueuedCommandAfter(
          harness,
          start.row.cursor,
          ({ command }) =>
            command.type === "thread.rename" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      expect(
        listQueuedThreadCommands(harness, "thread.rename", thread.id),
      ).toEqual([]);
    });
  });
  it("skips inference entirely when no inference model is configured", async () => {
    await withTestHarness(
      {
        inferenceModel: "openai/gpt-4o-mini",
        openAiApiKey: "",
      },
      async (harness) => {
        await expect(
          generateThreadMetadataWithOutcome(harness.deps, {
            input: textInput("Improve the generated title fallback path"),
            threadId: "thr_inference_unavailable",
          }),
        ).resolves.toMatchObject({
          metadata: null,
          reason: "inference-unavailable",
        });
        expect(piAiMocks.getModel).toHaveBeenCalledWith(
          "openai",
          "gpt-4o-mini",
        );
        expect(piAiMocks.complete).not.toHaveBeenCalled();
      },
    );
  });

  it("returns no metadata when inference times out", async () => {
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete.mockReturnValue(new Promise(() => undefined));
    const harness = await createTestAppHarness();
    const infoSpy = vi.spyOn(harness.deps.logger, "info");
    try {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Improve timed out metadata generation behavior"),
          threadId: "thr_timeout",
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({
        metadata: null,
        reason: "timeout",
      });
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 1,
          threadId: "thr_timeout",
          timeoutMs: 1,
        }),
        "Thread metadata inference timed out",
      );
    } finally {
      infoSpy.mockRestore();
      await harness.cleanup();
    }
  });

  it("retries once when metadata inference times out", async () => {
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(
        mockThreadMetadataCompletion({
          title: "Recovered Metadata",
        }),
      );
    const harness = await createTestAppHarness();
    const infoSpy = vi.spyOn(harness.deps.logger, "info");
    try {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Improve timed out metadata generation behavior"),
          threadId: "thr_retry_timeout",
          timeoutMaxAttempts: 2,
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({
        metadata: { title: "Recovered Metadata" },
      });
      expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
      expect(piAiMocks.getModel).toHaveBeenNthCalledWith(
        1,
        "test",
        "mock-model",
      );
      expect(piAiMocks.getModel).toHaveBeenNthCalledWith(
        2,
        "test",
        "mock-fallback-model",
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          fallbackModel: "test/mock-fallback-model",
          maxAttempts: 2,
          threadId: "thr_retry_timeout",
          timeoutMs: 1,
        }),
        "Thread metadata inference failed transiently; using fallback model",
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 2,
          threadId: "thr_retry_timeout",
        }),
        "Thread metadata inference completed with fallback model",
      );
    } finally {
      infoSpy.mockRestore();
      await harness.cleanup();
    }
  });

  it("retries transient Codex service failures", async () => {
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete
      .mockRejectedValueOnce(
        new AiServiceCallError(
          "codex",
          "service_unavailable",
          "Our servers are currently overloaded. Please try again later.",
        ),
      )
      .mockResolvedValueOnce(
        mockThreadMetadataCompletion({
          title: "Recovered Metadata",
        }),
      );

    await withTestHarness(async (harness) => {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Recover transient metadata provider failures"),
          threadId: "thr_retry_service_unavailable",
          timeoutMaxAttempts: 2,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        metadata: { title: "Recovered Metadata" },
      });
      expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
      expect(piAiMocks.getModel).toHaveBeenNthCalledWith(
        1,
        "test",
        "mock-model",
      );
      expect(piAiMocks.getModel).toHaveBeenNthCalledWith(
        2,
        "test",
        "mock-fallback-model",
      );
    });
  });

  it("does not retry non-transient metadata inference failures", async () => {
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete.mockRejectedValue(new Error("metadata failed"));
    await withTestHarness(async (harness) => {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Improve failed metadata generation behavior"),
          threadId: "thr_failed_metadata",
          timeoutMaxAttempts: 2,
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({
        metadata: null,
        reason: "failed",
      });
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
    });
  });
});
