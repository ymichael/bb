import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import {
  providerOperations,
  type TestEnvironmentProviderContext,
  type TestProviderDecision,
} from "../helpers/provider-decisions.js";
import {
  createEnvironment,
  createProjectSource,
  ensurePersonalProject,
  getEnvironmentLaunch,
  getEnvironment,
  getHost,
  getMachineLaunch,
  getDefaultProjectSource,
  getThread,
  listEnvironments,
  listEvents,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  PERSONAL_PROJECT_ID,
  type JsonValue,
} from "@bb/domain";
import type {
  PluginDispatchEnvironmentIntent,
  PluginEnvironmentProviderDeclaration,
  PluginMachineProviderDeclaration,
  PluginEnvironmentValidateDecision,
  PluginHookName,
} from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderValidateContext } from "@get-bb/plugin-sdk/environment-provider";
import {
  validatePluginEnvironmentProviderDeclaration,
  validatePluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError } from "../../src/errors.js";
import { persistPendingProviderRequest } from "../../src/services/environments/provider-orchestration.js";
import {
  listEnvironmentProviders,
  requestEnvironmentProviderRecheck,
  setPluginEnvironmentProviderBridge,
  type PluginEnvironmentProviderRecord,
} from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { attemptDispatch } from "../../src/services/threads/dispatch-attempt.js";
import {
  recheckEnvironmentProviderLaunches,
  scheduledEnvironmentProviderAskCount,
} from "../../src/services/threads/thread-environment-providers.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import {
  forgetAllActiveThreadProvisionContexts,
  getActiveThreadProvisionContext,
} from "../../src/services/threads/thread-provisioning-active-context.js";
import { createMetadataPendingContext } from "../../src/services/threads/thread-provisioning-context.js";
import {
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/environment-providers-project";
const PLUGIN_ID = "sandbox";
const PROVIDER_ID = "container";

interface FakeTarget {
  id?: string;
  remove?: PluginEnvironmentProviderDeclaration["remove"];
  provision: (
    context: TestEnvironmentProviderContext,
  ) => TestProviderDecision | Promise<TestProviderDecision>;
  requiresProjectCheckout?: boolean;
  requiresGitCheckout?: boolean;
  requiresGitRemote?: boolean;
  requiresProjectless?: boolean;
  inputs?: z.ZodType;
  validate?: (
    context: PluginEnvironmentProviderValidateContext,
  ) =>
    | PluginEnvironmentValidateDecision
    | Promise<PluginEnvironmentValidateDecision>;
  availability?: PluginEnvironmentProviderDeclaration["availability"];
}

const CONTAINER_INPUTS = z.object({
  image: z.string().min(1),
  cpus: z.number().int().positive().default(2),
});

function installTargets(fakes: FakeTarget[]): void {
  const records: PluginEnvironmentProviderRecord[] = fakes.map((fake) => ({
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: fake.id ?? PROVIDER_ID,
      displayName: "Fake container",
      requires: {
        projectCheckout: fake.requiresProjectCheckout ?? false,
        gitCheckout: fake.requiresGitCheckout ?? false,
        gitRemote: fake.requiresGitRemote ?? false,
        projectless: fake.requiresProjectless ?? false,
      },
      ...(fake.inputs === undefined ? {} : { inputs: fake.inputs }),
      ...(fake.validate === undefined ? {} : { validate: fake.validate }),
      ...(fake.availability === undefined
        ? {}
        : { availability: fake.availability }),
      ...providerOperations(fake.provision),
      ...(fake.remove === undefined ? {} : { remove: fake.remove }),
    }),
  }));
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => records,
    getEnvironmentProvider: (id) =>
      records.find((record) => record.provider.id === id),
    invokeProvider: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: 10_000,
  });
}

function installTarget(fake: FakeTarget | null): void {
  installTargets(fake === null ? [] : [fake]);
}

function installEnvironmentIntentProbe(): PluginDispatchEnvironmentIntent[] {
  const environmentIntents: PluginDispatchEnvironmentIntent[] = [];
  const registry: {
    [K in PluginHookName]: PluginHookRegistration<K>[];
  } = { "message.dispatch": [] };
  registry["message.dispatch"].push({
    pluginId: "observer",
    handler: (context) => {
      if (context.environmentIntent !== null)
        environmentIntents.push(context.environmentIntent);
      return { action: "proceed" } as const;
    },
  });
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  return environmentIntents;
}

afterEach(() => {
  forgetAllActiveThreadProvisionContexts();
  setPluginEnvironmentProviderBridge(undefined);
  setPluginMachineProviderBridge(undefined);
  setPluginHookProvider(undefined);
});

function seedTargetFixture(
  harness: TestAppHarness,
  hostId: string,
  args: { environmentProviderId?: string } = {},
) {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
    ...(args.environmentProviderId === undefined
      ? {}
      : { environmentProviderId: args.environmentProviderId }),
  });
  return { environment, host, project, session };
}

function createTargetThread(
  harness: TestAppHarness,
  args: {
    projectId: string;
    inputs?: JsonValue | null;
    hostId?: string | null;
    model?: string | undefined;
    environmentProviderId?: string;
  },
) {
  const model = "model" in args ? args.model : "requested-model";
  const source = getDefaultProjectSource(harness.db, args.projectId);
  const sourceHostId = source?.type === "local_path" ? source.hostId : null;
  const hostId = args.hostId ?? sourceHostId ?? "host-1";
  return createThreadFromRequest(harness.deps, {
    environment: {
      type: "provider",
      environmentProviderId: args.environmentProviderId ?? PROVIDER_ID,
      machine: { type: "existing", hostId },
      inputs: args.inputs ?? null,
    },
    input: textInput("Do the thing"),
    origin: "app",
    projectId: args.projectId,
    providerId: "codex",
    ...(model !== undefined ? { model } : {}),
    startedOnBehalfOf: null,
  });
}

function provisioningEvents(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/thread-provisioning")
    .map(
      (event) =>
        JSON.parse(event.data) as {
          status: string;
          environmentId: string | null;
          entries: Array<{ type: string; key: string; text: string }>;
        },
    );
}

function blockEntries(harness: TestAppHarness, threadId: string) {
  return provisioningEvents(harness, threadId).flatMap((event) =>
    event.entries.map((entry) => [entry.type, entry.text] as const),
  );
}

function readyAt(host: { id: string }): TestProviderDecision {
  return {
    action: "ready",
    environment: {
      type: "host",
      hostId: host.id,
      path: WORKSPACE_PATH,
    },
  };
}

describe("environment providers are asked inside provisioning", () => {
  it("shares a projectless parent's personal workspace when no environment flags are supplied", async () => {
    await withTestHarness(async (harness) => {
      installTargets([
        {
          id: "personal-workspace",
          provision: () => ({
            action: "wait",
            reason: "Preparing personal workspace",
          }),
          requiresProjectless: true,
        },
      ]);
      const { host } = seedHostSession(harness.deps, {
        id: "host-projectless-child",
      });
      seedPrimaryHost(harness.deps, host.id);
      ensurePersonalProject(harness.db);
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        providerOwnsPath: true,
        hostId: host.id,
        projectId: PERSONAL_PROJECT_ID,
        path: "/tmp/projectless-parent",
        status: "ready",
        environmentProvider: {
          environmentProviderId: "personal-workspace",
          instanceKey: null,
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
      });
      const parent = seedThread(harness.deps, {
        environmentId: parentEnvironment.id,
        projectId: PERSONAL_PROJECT_ID,
        status: "idle",
      });

      const child = await createThreadFromRequest(harness.deps, {
        environment: { type: "project-default" },
        input: textInput("Do the thing"),
        origin: "cli",
        parentThreadId: parent.id,
        projectId: PERSONAL_PROJECT_ID,
        providerId: "codex",
        model: "requested-model",
        startedOnBehalfOf: null,
      });

      expect(
        getActiveThreadProvisionContext(child.id)?.request.environmentIntent,
      ).toEqual({
        type: "reuse",
        environmentId: parentEnvironment.id,
      });
    });
  });

  it("opens the workspace-setup block and parks the thread starting on a wait", async () => {
    await withTestHarness(async (harness) => {
      const contexts: TestEnvironmentProviderContext[] = [];
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: (context) => {
          contexts.push(context);
          return { action: "wait", reason: "Starting container…" };
        },
      });
      const { project } = seedTargetFixture(harness, "host-target-wait");
      const created = await createTargetThread(harness, {
        projectId: project.id,
        inputs: { image: "img" },
      });

      await vi.waitFor(() => {
        expect(blockEntries(harness, created.id)).toContainEqual([
          "step",
          "Starting container…",
        ]);
      });
      const thread = getThread(harness.db, created.id);
      expect(thread?.status).toBe("starting");
      expect(thread?.environmentId).toBeNull();
      expect(contexts.length).toBeGreaterThanOrEqual(1);
      expect(contexts[0]?.thread.id).toBe(created.id);
      expect(contexts[0]?.inputs).toEqual({ image: "img", cpus: 2 });
      const entries = blockEntries(harness, created.id);
      expect(entries[0]).toEqual(["step", "Preparing workspace"]);
      expect(
        provisioningEvents(harness, created.id).every(
          (event) => event.status === "active" && event.environmentId === null,
        ),
      ).toBe(true);
      expect(scheduledEnvironmentProviderAskCount()).toBe(1);
    });
  });

  it("passes transformed inputs to create without parsing them twice", async () => {
    await withTestHarness(async (harness) => {
      const inputs: JsonValue[] = [];
      installTarget({
        inputs: z.string().transform(Number),
        provision: (context) => {
          inputs.push(context.inputs);
          return { action: "wait", reason: "Starting container…" };
        },
      });
      const { project } = seedTargetFixture(
        harness,
        "host-target-transformed-inputs",
      );
      await createTargetThread(harness, {
        projectId: project.id,
        inputs: "2",
      });

      await expect.poll(() => inputs).toEqual([2]);
    });
  });

  it("attaches a ready answer through placement and tells the hook the environment intent", async () => {
    await withTestHarness(async (harness) => {
      const environmentIntents = installEnvironmentIntentProbe();
      const { environment, host, project } = seedTargetFixture(
        harness,
        "host-target-ready",
        { environmentProviderId: PROVIDER_ID },
      );
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: () => readyAt(host),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
        inputs: { image: "img", cpus: 4 },
      });

      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.environmentId).toBe(
          environment.id,
        );
      });
      expect(getThread(harness.db, created.id)?.status).toBe("starting");
      expect(environmentIntents).toEqual([
        {
          kind: "provider",
          environmentProviderId: PROVIDER_ID,
          machine: { type: "existing", hostId: host.id },
          inputs: { image: "img", cpus: 4 },
        },
      ]);
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
    });
  });

  it("re-asks on recheck and streams steps and output into the block", async () => {
    await withTestHarness(async (harness) => {
      let ask = 0;
      const { environment, host, project } = seedTargetFixture(
        harness,
        "host-target-recheck",
        { environmentProviderId: PROVIDER_ID },
      );
      installTarget({
        provision: () => {
          ask += 1;
          if (ask === 1) {
            return { action: "wait", reason: "Starting container…" };
          }
          if (ask === 2) {
            return {
              action: "wait",
              reason: "Cloning repository…",
              log: "cloned 100 objects",
            };
          }
          return { ...readyAt(host), log: "scripts/setup.sh: done" };
        },
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(blockEntries(harness, created.id)).toContainEqual([
          "step",
          "Starting container…",
        ]);
      });

      recheckEnvironmentProviderLaunches(harness.deps, PLUGIN_ID);
      await vi.waitFor(() => {
        expect(blockEntries(harness, created.id)).toContainEqual([
          "output",
          "cloned 100 objects",
        ]);
      });
      recheckEnvironmentProviderLaunches(harness.deps, PLUGIN_ID);
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.environmentId).toBe(
          environment.id,
        );
      });

      const entries = blockEntries(harness, created.id);
      const targetEntries = entries.filter(
        ([, text]) =>
          text.includes("container") ||
          text.includes("repository") ||
          text.includes("cloned") ||
          text.includes("setup.sh"),
      );
      expect(targetEntries).toEqual([
        ["step", "Preparing Fake container…"],
        ["step", "Preparing Fake container…"],
        ["step", "Starting container…"],
        ["step", "Starting container…"],
        ["step", "Cloning repository…"],
        ["output", "cloned 100 objects"],
        ["step", "Cloning repository…"],
        ["output", "scripts/setup.sh: done"],
      ]);
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
    });
  });

  it("refuses a host answer naming a path another provider's row holds", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-foreign-path",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      const foreign = seedEnvironment(harness.deps, {
        environmentProviderId: "git-worktree",
        hostId: host.id,
        path: "/tmp/environment-providers-foreign",
        projectId: project.id,
      });
      installTarget({
        provision: () => ({
          action: "ready",
          environment: {
            type: "host",
            hostId: host.id,
            path: "/tmp/environment-providers-foreign",
          },
        }),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.status).toBe("error");
      });
      const error = listEvents(harness.db, { threadId: created.id }).find(
        (event) => event.type === "system/error",
      );
      const detail = (JSON.parse(error?.data ?? "null") as { detail: string })
        .detail;
      expect(detail).toContain(`"${PROVIDER_ID}" environment provider`);
      expect(detail).toContain('which the "git-worktree" environment provider');
      expect(
        getEnvironment(harness.db, foreign.id)?.environmentProviderId,
      ).toBe("git-worktree");
      expect(getThread(harness.db, created.id)?.environmentId).toBeNull();
    });
  });

  it("records the branch a reused host row is on when the provider answers with its path", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-refresh-branch",
      );
      const attached = seedEnvironment(harness.deps, {
        branchName: "main",
        environmentProviderId: PROVIDER_ID,
        environmentProviderInstanceKey: "old-instance",
        environmentProviderSelection: {
          machine: { type: "existing", hostId: "old-host" },
          inputs: { stale: true },
        },
        hostId: host.id,
        path: "/tmp/environment-providers-refresh-branch",
        projectId: project.id,
      });
      const inspected: string[] = [];
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
        gitSourceInspectionResult: {
          isWorktree: false,
          checkout: {
            kind: "branch",
            branchName: "release",
            headSha: "def456",
          },
          defaultBranch: "main",
          defaultBranchRelation: "local-ahead",
          hasUncommittedChanges: false,
          operation: { kind: "none" },
          originDefaultBranch: "origin/main",
        },
        onInspectGitSource: (command) => {
          inspected.push(command.path);
        },
      });
      installTarget({
        provision: () => ({
          action: "ready",
          environment: {
            type: "host",
            hostId: host.id,
            path: "/tmp/environment-providers-refresh-branch",
          },
        }),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(getEnvironment(harness.db, attached.id)?.branchName).toBe(
          "release",
        );
      });
      expect(getThread(harness.db, created.id)?.environmentId).toBe(
        attached.id,
      );
      expect(inspected).toEqual(["/tmp/environment-providers-refresh-branch"]);
      expect(getEnvironment(harness.db, attached.id)).toMatchObject({
        environmentProviderInstanceKey: created.id,
        environmentProviderSelection: {
          machine: { type: "existing", hostId: host.id },
          inputs: null,
        },
      });
    });
  });

  it("fails the thread with the plugin named when provision throws", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        provision: () => {
          throw new Error("docker daemon unreachable");
        },
      });
      const { project } = seedTargetFixture(harness, "host-target-throw");
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.status).toBe("error");
      });
      const error = listEvents(harness.db, { threadId: created.id }).find(
        (event) => event.type === "system/error",
      );
      const detail = (JSON.parse(error?.data ?? "null") as { detail: string })
        .detail;
      expect(detail).toContain(PLUGIN_ID);
      expect(detail).toContain("docker daemon unreachable");
      expect(provisioningEvents(harness, created.id).at(-1)?.status).toBe(
        "failed",
      );
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
    });
  });

  it("retries a provider launch on the next send after failure before a row attaches", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, project } = seedTargetFixture(
        harness,
        "host-target-retry-pre-row",
        { environmentProviderId: PROVIDER_ID },
      );
      installTarget({
        provision: () => {
          throw new Error("temporary launch failure");
        },
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.status).toBe("error");
      });

      const asks: string[] = [];
      installTarget({
        provision: (context) => {
          asks.push(context.thread.id);
          return readyAt(host);
        },
      });
      const failedThread = getThread(harness.db, created.id);
      expect(failedThread).not.toBeNull();
      if (failedThread === null) return;

      const outcome = await attemptDispatch(harness.deps, {
        thread: failedThread,
        payload: { input: textInput("Retry the task"), mode: "start" },
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        origin: null,
        originPluginId: null,
        startedOnBehalfOf: null,
        trigger: "user",
      });

      expect(outcome.kind).toBe("dispatched");
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.environmentId).toBe(
          environment.id,
        );
      });
      expect(asks).toEqual([created.id]);
      expect(getThread(harness.db, created.id)?.status).toBe("starting");
    });
  });

  it("fails the thread with the target's message when it rejects", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        provision: () => ({
          action: "reject",
          message: "Choose a container image.",
        }),
      });
      const { project } = seedTargetFixture(harness, "host-target-reject");
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.status).toBe("error");
      });
      const error = listEvents(harness.db, { threadId: created.id }).find(
        (event) => event.type === "system/error",
      );
      expect(
        (JSON.parse(error?.data ?? "null") as { detail: string }).detail,
      ).toBe("Choose a container image.");
    });
  });

  it("rejects an unknown environment provider at create", async () => {
    await withTestHarness(async (harness) => {
      installTarget(null);
      const { project } = seedTargetFixture(harness, "host-target-missing");
      const failed = await createTargetThread(harness, {
        projectId: project.id,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ApiError);
      expect((failed as ApiError).status).toBe(400);
      expect((failed as ApiError).body.code).toBe("invalid_request");
      expect((failed as ApiError).message).toBe("unknown environment provider");
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
    });
  });

  it("refuses a checkout provider that needs no git on a machine without the project", async () => {
    await withTestHarness(async (harness) => {
      installTargets([
        {
          provision: () => ({ action: "wait", reason: "…" }),
          requiresProjectCheckout: true,
        },
      ]);
      const { project } = seedTargetFixture(harness, "host-target-checkout");
      const { host: bare } = seedHostSession(harness.deps, {
        id: "host-target-bare",
      });
      const failed = await createTargetThread(harness, {
        projectId: project.id,
        hostId: bare.id,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ApiError);
      expect((failed as ApiError).body.code).toBe("invalid_request");
      expect((failed as ApiError).message).toContain("No project source");
    });
  });

  it("refuses a projectless-only provider for a thread in a project", async () => {
    await withTestHarness(async (harness) => {
      installTargets([
        {
          provision: () => ({ action: "wait", reason: "…" }),
          requiresProjectless: true,
        },
      ]);
      const { project } = seedTargetFixture(harness, "host-target-projectless");
      const failed = await createTargetThread(harness, {
        projectId: project.id,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ApiError);
      expect((failed as ApiError).body.code).toBe("invalid_request");
      expect((failed as ApiError).message).toContain("no project");
    });
  });

  it("refuses a git-remote provider without a remote when validate is absent", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        requiresGitRemote: true,
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(harness, "host-target-no-remote");
      const failed = await createTargetThread(harness, {
        projectId: project.id,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ApiError);
      if (!(failed instanceof ApiError)) {
        throw new Error("expected provider selection to be rejected");
      }
      expect(failed.body.code).toBe("environment_provider_rejected");
      expect(failed.message).toContain("has no git remote");
    });
  });

  it("applies git-checkout availability eligibility to explicit selection", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        requiresGitCheckout: true,
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-unusable-git-checkout",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
        gitSourceInspectionResult: {
          checkout: { kind: "unborn", branchName: "main" },
          defaultBranch: null,
          defaultBranchRelation: null,
          isWorktree: false,
          hasUncommittedChanges: false,
          operation: { kind: "none" },
          originDefaultBranch: null,
        },
      });
      const failed = await createTargetThread(harness, {
        projectId: project.id,
        hostId: host.id,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ApiError);
      if (!(failed instanceof ApiError)) {
        throw new Error("expected provider selection to be rejected");
      }
      expect(failed.body.code).toBe("environment_provider_rejected");
      expect(failed.message).toContain("no usable git branch");
    });
  });

  it("resolves the model catalog through the selection's hostId for a host-scoped selection", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        provision: () => ({ action: "wait", reason: "Creating…" }),
      });
      const { host, project } = seedTargetFixture(
        harness,
        "host-target-scoped",
      );
      const created = await createTargetThread(harness, {
        projectId: project.id,
        hostId: host.id,
        model: undefined,
      });
      expect(getThread(harness.db, created.id)?.status).toBe("starting");
    });
  });
});

describe("provider validate at create time", () => {
  async function createFailure(
    harness: TestAppHarness,
    args: Parameters<typeof createTargetThread>[1],
  ): Promise<ApiError> {
    const failed = await createTargetThread(harness, args).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ApiError);
    return failed as ApiError;
  }

  it("refuses the request with the provider's message before any thread or row exists", async () => {
    await withTestHarness(async (harness) => {
      const asks: TestEnvironmentProviderContext[] = [];
      installTarget({
        validate: () => ({
          action: "refuse",
          message: "No room left on this machine",
        }),
        provision: (context) => {
          asks.push(context);
          return { action: "wait", reason: "…" };
        },
      });
      const { host, project } = seedTargetFixture(
        harness,
        "host-target-validate-refuse",
      );
      const before = listEnvironments(harness.db, {}).length;

      const failed = await createFailure(harness, {
        projectId: project.id,
        hostId: host.id,
      });
      expect(failed.status).toBe(409);
      expect(failed.body.code).toBe("environment_provider_rejected");
      expect(failed.message).toBe("No room left on this machine");
      expect(listEnvironments(harness.db, {})).toHaveLength(before);
      expect(asks).toHaveLength(0);
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
    });
  });

  it("hands validate the parsed inputs and the machine's checkout, then proceeds on accept", async () => {
    await withTestHarness(async (harness) => {
      const seen: PluginEnvironmentProviderValidateContext[] = [];
      installTarget({
        requiresProjectCheckout: true,
        inputs: CONTAINER_INPUTS,
        validate: (context) => {
          seen.push(context);
          return { action: "accept" };
        },
        provision: () => ({ action: "wait", reason: "Creating…" }),
      });
      const { host, project } = seedTargetFixture(
        harness,
        "host-target-validate-accept",
      );
      const created = await createTargetThread(harness, {
        projectId: project.id,
        hostId: host.id,
        inputs: { image: "ubuntu" },
      });
      expect(getThread(harness.db, created.id)?.status).toBe("starting");
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toMatchObject({
        host: { id: host.id },
        project: { id: project.id },
        projectCheckout: { path: WORKSPACE_PATH },
        gitRemote: null,
        inputs: { image: "ubuntu", cpus: 2 },
      });
    });
  });

  it("fails the request with the plugin named when validate answers a shape core cannot read", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        validate: () =>
          ({ action: "maybe" }) as unknown as PluginEnvironmentValidateDecision,
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(
        harness,
        "host-target-validate-shape",
      );
      const failed = await createFailure(harness, { projectId: project.id });
      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe("environment_provider_failed");
      expect(failed.message).toContain(`plugin "${PLUGIN_ID}"`);
      expect(failed.message).toContain('{ action: "accept" }');
    });
  });

  it("fails the request, not the server, when validate throws", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        validate: () => {
          throw new Error("validator exploded");
        },
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(
        harness,
        "host-target-validate-throw",
      );
      const failed = await createFailure(harness, { projectId: project.id });
      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe("environment_provider_failed");
      expect(failed.message).toContain(`plugin "${PLUGIN_ID}"`);
      expect(failed.message).toContain("validator exploded");
    });
  });
});

describe("provider inputs are parsed at create time", () => {
  async function createFailure(
    harness: TestAppHarness,
    args: Parameters<typeof createTargetThread>[1],
  ): Promise<ApiError> {
    const failed = await createTargetThread(harness, args).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ApiError);
    return failed as ApiError;
  }

  it("refuses malformed inputs with the provider and the issues named, before any row exists", async () => {
    await withTestHarness(async (harness) => {
      const asks: TestEnvironmentProviderContext[] = [];
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: (context) => {
          asks.push(context);
          return { action: "wait", reason: "…" };
        },
      });
      const { project } = seedTargetFixture(harness, "host-target-bad-inputs");
      const before = listEnvironments(harness.db, {}).length;

      const failed = await createFailure(harness, {
        projectId: project.id,
        inputs: { image: "", cpus: "many" },
      });
      expect(failed.status).toBe(400);
      expect(failed.body.code).toBe("invalid_request");
      expect(failed.message).toContain(`"${PROVIDER_ID}"`);
      expect(failed.message).toContain("image:");
      expect(failed.message).toContain("cpus:");
      expect(listEnvironments(harness.db, {})).toHaveLength(before);
      expect(asks).toHaveLength(0);
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
    });
  });

  it("refuses a provider with inputs when the request carries none", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(harness, "host-target-no-inputs");
      const failed = await createFailure(harness, { projectId: project.id });
      expect(failed.status).toBe(400);
      expect(failed.body.code).toBe("invalid_request");
      expect(failed.message).toContain("needs inputs");
    });
  });

  it("refuses inputs for a provider that declares none", async () => {
    await withTestHarness(async (harness) => {
      installTarget({ provision: () => ({ action: "wait", reason: "…" }) });
      const { project } = seedTargetFixture(
        harness,
        "host-target-unexpected-inputs",
      );
      const failed = await createFailure(harness, {
        projectId: project.id,
        inputs: { image: "img" },
      });
      expect(failed.status).toBe(400);
      expect(failed.body.code).toBe("invalid_request");
      expect(failed.message).toContain("takes no inputs");
    });
  });

  it("fails the request, not the server, when the schema throws", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        inputs: z.object({ image: z.string() }).transform(() => {
          throw new Error("registry unreachable");
        }),
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(harness, "host-target-throwing");
      const failed = await createFailure(harness, {
        projectId: project.id,
        inputs: { image: "img" },
      });
      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe("environment_provider_failed");
      expect(failed.message).toContain(PLUGIN_ID);
      expect(failed.message).toContain("registry unreachable");
    });
  });

  it("lists each provider's requires and inputs as JSON Schema", async () => {
    await withTestHarness(async (harness) => {
      installTargets([
        {
          inputs: CONTAINER_INPUTS,
          provision: () => ({ action: "wait", reason: "…" }),
        },
        {
          id: "plain",
          provision: () => ({ action: "wait", reason: "…" }),
        },
      ]);
      const response = await harness.app.request(
        "/api/v1/system/environment-providers",
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as {
        providers: Array<{
          id: string;
          requires: Record<string, boolean>;
          inputs: JsonValue | null;
        }>;
      };
      expect(body.providers).toEqual([
        {
          id: PROVIDER_ID,
          displayName: "Fake container",
          icon: null,
          logoUrl: null,
          pluginId: PLUGIN_ID,
          requires: {
            projectCheckout: false,
            gitCheckout: false,
            gitRemote: false,
            projectless: false,
          },
          inputs: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              image: expect.objectContaining({ type: "string" }),
              cpus: expect.objectContaining({ type: "integer", default: 2 }),
            }),
            required: ["image"],
          }),
          acceptsEmptyInputs: false,
          availability: null,
        },
        {
          id: "plain",
          displayName: "Fake container",
          icon: null,
          logoUrl: null,
          pluginId: PLUGIN_ID,
          requires: {
            projectCheckout: false,
            gitCheckout: false,
            gitRemote: false,
            projectless: false,
          },
          inputs: null,
          acceptsEmptyInputs: true,
          availability: null,
        },
      ]);
    });
  });
});

describe("environment provider listing", () => {
  it("filters project and projectless providers before evaluating availability", async () => {
    await withTestHarness(async (harness) => {
      const availabilityChecks: string[] = [];
      installTargets([
        {
          id: "project-only",
          availability: () => {
            availabilityChecks.push("project-only");
            return { status: "available" };
          },
          provision: () => ({ action: "wait", reason: "…" }),
        },
        {
          id: "projectless-only",
          requiresProjectless: true,
          availability: () => {
            availabilityChecks.push("projectless-only");
            return { status: "available" };
          },
          provision: () => ({ action: "wait", reason: "…" }),
        },
      ]);
      const { project } = seedTargetFixture(
        harness,
        "host-provider-structural-filter",
      );
      ensurePersonalProject(harness.db);

      const projectBody = (await readJson(
        await harness.app.request(
          `/api/v1/system/environment-providers?projectId=${project.id}`,
        ),
      )) as { providers: Array<{ id: string }> };
      expect(projectBody.providers.map((provider) => provider.id)).toEqual([
        "project-only",
      ]);
      expect(availabilityChecks).toEqual(["project-only"]);

      availabilityChecks.length = 0;
      const projectlessBody = (await readJson(
        await harness.app.request(
          `/api/v1/system/environment-providers?projectId=${PERSONAL_PROJECT_ID}`,
        ),
      )) as { providers: Array<{ id: string }> };
      expect(projectlessBody.providers.map((provider) => provider.id)).toEqual([
        "projectless-only",
      ]);
      expect(availabilityChecks).toEqual(["projectless-only"]);
    });
  });

  it("lists Project checkout and Worktree first, then providers by display name and id", async () => {
    await withTestHarness(async (harness) => {
      installTargets([
        { id: "zulu", provision: () => ({ action: "wait", reason: "…" }) },
        {
          id: "personal-workspace",
          provision: () => ({ action: "wait", reason: "…" }),
        },
        {
          id: "project-checkout",
          provision: () => ({ action: "wait", reason: "…" }),
        },
        { id: "alpha", provision: () => ({ action: "wait", reason: "…" }) },
        {
          id: "git-worktree",
          provision: () => ({ action: "wait", reason: "…" }),
        },
      ]);

      const response = await harness.app.request(
        "/api/v1/system/environment-providers",
      );
      const body = (await readJson(response)) as {
        providers: Array<{ id: string }>;
      };
      expect(body.providers.map((provider) => provider.id)).toEqual([
        "project-checkout",
        "git-worktree",
        "alpha",
        "personal-workspace",
        "zulu",
      ]);
    });
  });

  it("returns provider-owned availability for a project", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        availability: () => ({
          status: "setup-required",
          message: "Add sandbox credentials",
        }),
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(
        harness,
        "host-provider-availability",
      );

      const response = await harness.app.request(
        `/api/v1/system/environment-providers?projectId=${project.id}`,
      );
      const body = (await readJson(response)) as {
        providers: Array<{ availability: unknown }>;
      };
      expect(body.providers[0]?.availability).toEqual({
        status: "setup-required",
        message: "Add sandbox credentials",
      });
    });
  });

  it("caches availability until the provider requests a recheck", async () => {
    await withTestHarness(async (harness) => {
      let checks = 0;
      installTarget({
        availability: () => {
          checks += 1;
          return { status: "available" };
        },
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(
        harness,
        "host-provider-availability-cache",
      );
      const path = `/api/v1/system/environment-providers?projectId=${project.id}`;

      await harness.app.request(path);
      await harness.app.request(path);
      expect(checks).toBe(1);

      requestEnvironmentProviderRecheck(PLUGIN_ID);
      await harness.app.request(path);
      expect(checks).toBe(2);
    });
  });

  it("recomputes core availability after a checkout is added", async () => {
    await withTestHarness(async (harness) => {
      let checks = 0;
      installTarget({
        requiresProjectCheckout: true,
        availability: () => {
          checks += 1;
          return { status: "available" };
        },
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { host: sourceHost } = seedHostSession(harness.deps, {
        id: "host-source",
      });
      const { host: targetHost } = seedHostSession(harness.deps, {
        id: "host-target",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: sourceHost.id,
      });
      const path = `/api/v1/system/environment-providers?projectId=${project.id}&hostId=${targetHost.id}`;

      const before = (await readJson(await harness.app.request(path))) as {
        providers: Array<{ availability: unknown }>;
      };
      expect(before.providers[0]?.availability).toEqual({
        status: "unavailable",
        message: "This project has no checkout on the selected machine.",
      });
      expect(checks).toBe(0);

      createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: targetHost.id,
        path: "/tmp/target-checkout",
      });

      const after = (await readJson(await harness.app.request(path))) as {
        providers: Array<{ availability: unknown }>;
      };
      expect(after.providers[0]?.availability).toEqual({
        status: "available",
      });
      expect(checks).toBe(1);
    });
  });

  it("names the plugin when its availability hook throws", async () => {
    await withTestHarness(async (harness) => {
      installTarget({
        availability: () => {
          throw new Error("credential service failed");
        },
        provision: () => ({ action: "wait", reason: "…" }),
      });
      const { project } = seedTargetFixture(
        harness,
        "host-provider-availability-error",
      );

      const response = await harness.app.request(
        `/api/v1/system/environment-providers?projectId=${project.id}`,
      );
      const body = (await readJson(response)) as {
        providers: Array<{ availability: unknown }>;
      };
      expect(body.providers[0]?.availability).toEqual({
        status: "unavailable",
        message:
          'Plugin "sandbox" could not determine availability: credential service failed',
      });
    });
  });
});

describe("machine and environment provider composition", () => {
  it("creates a machine plus checkout, then a worktree on the same machine", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provider-composition",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: WORKSPACE_PATH,
      });
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      const machineProvider = validatePluginMachineProviderDeclaration({
        id: "test-machine",
        displayName: "Test machine",
        environmentRow: {
          displayName: "Test machine",
          environmentProviderId: "project-checkout",
        },
        policy: {
          idleSuspendMs: null,
          retire: { after: "never" },
          removeRetryMs: 30_000,
        },
        create: async ({ key }) => ({
          status: "created",
          hostId: host.id,
          resource: { key },
        }),
        remove: async () => ({ status: "removed" }),
      } satisfies PluginMachineProviderDeclaration);
      const machineRecord = {
        pluginId: "test-machine-plugin",
        provider: machineProvider,
      };
      setPluginMachineProviderBridge({
        listMachineProviders: () => [machineRecord],
        getMachineProvider: (id) =>
          id === machineProvider.id ? machineRecord : undefined,
        invokeProvider: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      const worktreeContexts: TestEnvironmentProviderContext[] = [];
      installTargets([
        {
          id: "project-checkout",
          requiresProjectCheckout: true,
          provision: () => ({
            action: "ready",
            environment: {
              type: "host",
              hostId: host.id,
              path: WORKSPACE_PATH,
              ownsPath: false,
            },
          }),
        },
        {
          id: "git-worktree",
          requiresProjectCheckout: true,
          requiresGitCheckout: true,
          inputs: z.object({
            branch: z.object({ kind: z.literal("default") }),
          }),
          provision: (context) => {
            worktreeContexts.push(context);
            return {
              action: "ready",
              environment: {
                type: "host",
                hostId: host.id,
                path: "/tmp/provider-composition-worktree",
              },
            };
          },
        },
      ]);

      const checkoutThread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "provider",
          environmentProviderId: "project-checkout",
          machine: {
            type: "new",
            machineProviderId: "test-machine",
            inputs: null,
          },
          inputs: null,
        },
        input: textInput("Create the machine"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        model: "requested-model",
        startedOnBehalfOf: null,
      });
      await vi.waitFor(
        () => {
          expect(
            getThread(harness.db, checkoutThread.id)?.environmentId,
          ).not.toBeNull();
        },
        { timeout: 3_000 },
      );
      expect(getMachineLaunch(harness.db, checkoutThread.id)).toMatchObject({
        phase: "ready",
        hostId: host.id,
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        machineProviderId: "test-machine",
      });
      const checkoutEnvironment = getEnvironment(
        harness.db,
        getThread(harness.db, checkoutThread.id)?.environmentId ?? "",
      );
      expect(checkoutEnvironment?.environmentProviderSelection).toEqual({
        machine: {
          type: "new",
          machineProviderId: "test-machine",
          inputs: null,
        },
        inputs: null,
      });

      const worktreeThread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: host.id },
          inputs: { branch: { kind: "default" } },
        },
        input: textInput("Create a worktree"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        model: "requested-model",
        startedOnBehalfOf: null,
      });
      await vi.waitFor(
        () => {
          expect(
            getThread(harness.db, worktreeThread.id)?.environmentId,
          ).not.toBeNull();
        },
        { timeout: 3_000 },
      );
      expect(worktreeContexts).toHaveLength(1);
      expect(worktreeContexts[0]?.host.id).toBe(host.id);
      expect(
        getEnvironment(
          harness.db,
          getThread(harness.db, worktreeThread.id)?.environmentId ?? "",
        )?.hostId,
      ).toBe(host.id);
    });
  });
});

describe("core's worktree beside providers", () => {
  it("lists only registered providers and turns a worktree request into a worktree provider intent", async () => {
    await withTestHarness(async (harness) => {
      installTarget({ provision: () => ({ action: "wait", reason: "…" }) });
      expect(
        listEnvironmentProviders().map(
          (record) => `${record.pluginId}:${record.provider.id}`,
        ),
      ).toEqual([`${PLUGIN_ID}:${PROVIDER_ID}`]);

      const environmentIntents = installEnvironmentIntentProbe();
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-core-worktree",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      const created = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "named", name: "main" },
          },
        },
        input: textInput("Do the thing"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        model: "requested-model",
        startedOnBehalfOf: null,
      });
      expect(
        getActiveThreadProvisionContext(created.id)?.request.environmentIntent,
      ).toEqual({
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: host.id },
        inputs: { branch: { kind: "named", name: "main" } },
        selectionResolved: false,
        produced: null,
      });
      expect(environmentIntents).toEqual([
        {
          kind: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: host.id },
          inputs: { branch: { kind: "named", name: "main" } },
        },
      ]);
    });
  });
});

describe("a provider-produced environment over its life", () => {
  it("records the producing provider on the environment it creates", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-provenance",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: () => ({
          action: "ready",
          environment: {
            type: "host",
            hostId: host.id,
            path: "/tmp/environment-providers-fresh",
          },
        }),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
        inputs: { image: "img" },
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.environmentId).not.toBeNull();
      });
      const environmentId = getThread(harness.db, created.id)?.environmentId;
      const environment = getEnvironment(harness.db, environmentId ?? "");
      expect(environment?.environmentProviderId).toBe(PROVIDER_ID);
      expect(environment?.environmentProviderSelection).toEqual({
        machine: { type: "existing", hostId: host.id },
        inputs: { image: "img", cpus: 2 },
      });
      expect(environment?.environmentProviderInstanceKey).toBe(created.id);
      expect(environment?.providerOwnsPath).toBe(true);

      const listed = (await readJson(
        await harness.app.request(
          `/api/v1/environments?environmentProviderId=${PROVIDER_ID}&instanceKey=${created.id}`,
        ),
      )) as Array<{ id: string }>;
      expect(listed.map((row) => row.id)).toEqual([environmentId]);
    });
  });

  it("records that a provider only attached to a directory it does not own", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-attached",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: () => ({
          action: "ready",
          environment: {
            type: "host",
            hostId: host.id,
            path: "/tmp/environment-providers-attached",
            ownsPath: false,
          },
        }),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
        inputs: { image: "img" },
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.environmentId).not.toBeNull();
      });
      const environment = getEnvironment(
        harness.db,
        getThread(harness.db, created.id)?.environmentId ?? "",
      );
      expect(environment?.providerOwnsPath).toBe(false);

      const response = (await readJson(
        await harness.app.request(`/api/v1/environments/${environment?.id}`),
      )) as { managed: boolean; workspaceProvisionType: string | null };
      expect(response.managed).toBe(false);
      expect(response.workspaceProvisionType).toBeNull();
    });
  });

  it("records the base branch a provider says it branched from", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-merge-base",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: () => ({
          action: "ready",
          environment: {
            type: "host",
            hostId: host.id,
            path: "/tmp/environment-providers-merge-base",
            mergeBaseBranch: "origin/main",
          },
        }),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
        inputs: { image: "img" },
      });
      await vi.waitFor(() => {
        const environmentId = getThread(harness.db, created.id)?.environmentId;
        expect(getEnvironment(harness.db, environmentId ?? "")?.status).toBe(
          "ready",
        );
      });
      const environment = getEnvironment(
        harness.db,
        getThread(harness.db, created.id)?.environmentId ?? "",
      );
      expect(environment?.mergeBaseBranch).toBe("origin/main");
      expect(environment?.baseBranch).toBeNull();
    });
  });

  it("generates the instance key from the core launch path key", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, session } = seedTargetFixture(
        harness,
        "host-target-no-key",
      );
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      installTarget({
        provision: () => ({
          action: "ready",
          environment: {
            type: "host",
            hostId: host.id,
            path: "/tmp/environment-providers-unkeyed",
          },
        }),
      });
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, created.id)?.environmentId).not.toBeNull();
      });
      const environmentId = getThread(harness.db, created.id)?.environmentId;
      expect(
        getEnvironment(harness.db, environmentId ?? "")
          ?.environmentProviderInstanceKey,
      ).toBe(created.id);
    });
  });

  it("asks the provider again, with the old environment, when a send finds it destroyed", async () => {
    await withTestHarness(async (harness) => {
      const asks: TestEnvironmentProviderContext[] = [];
      const { host, project } = seedTargetFixture(harness, "host-target-reask");
      const replacement = seedEnvironment(harness.deps, {
        environmentProviderId: PROVIDER_ID,
        hostId: host.id,
        path: "/tmp/environment-providers-replacement",
        projectId: project.id,
      });
      const gone = createEnvironment(harness.db, harness.hub, {
        providerOwnsPath: false,
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/environment-providers-gone",
        status: "destroyed",
        environmentProvider: {
          environmentProviderId: PROVIDER_ID,
          instanceKey: null,
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: { image: "img", cpus: 2 },
          },
        },
      });
      const thread = seedThread(harness.deps, {
        environmentId: gone.id,
        projectId: project.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: gone.id,
        providerThreadId: "provider-reask",
        threadId: thread.id,
      });
      installTarget({
        inputs: CONTAINER_INPUTS,
        provision: (context) => {
          asks.push(context);
          return {
            action: "ready",
            environment: {
              type: "host",
              hostId: replacement.hostId,
              path: replacement.path!,
            },
          };
        },
      });

      const outcome = await attemptDispatch(harness.deps, {
        thread,
        payload: { input: textInput("Keep going"), mode: "start" },
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        origin: null,
        originPluginId: null,
        startedOnBehalfOf: null,
        trigger: "user",
      });
      expect(outcome.kind).toBe("dispatched");
      await vi.waitFor(() => {
        expect(getThread(harness.db, thread.id)?.environmentId).toBe(
          replacement.id,
        );
      });
      expect(asks).toHaveLength(1);
      expect(asks[0]?.environment?.id).toBe(gone.id);
      expect(asks[0]?.inputs).toEqual({ image: "img", cpus: 2 });
      expect(getThread(harness.db, thread.id)?.status).toBe("starting");
    });
  });

  it("aborts create and asks the provider to remove by path key when stopped", async () => {
    await withTestHarness(async (harness) => {
      const cancelled: string[] = [];
      installTarget({
        provision: () => ({ action: "wait", reason: "Starting container…" }),
        remove: async ({ pathKey }) => {
          cancelled.push(pathKey);
          return { status: "removed" };
        },
      });
      const { project } = seedTargetFixture(harness, "host-target-cancel");
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(scheduledEnvironmentProviderAskCount()).toBe(1);
      });

      const response = await harness.app.request(
        `/api/v1/threads/${created.id}/stop`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(cancelled).toEqual([created.id]);
      });
      expect(scheduledEnvironmentProviderAskCount()).toBe(0);
      expect(getThread(harness.db, created.id)?.status).not.toBe("starting");
      expect(provisioningEvents(harness, created.id).at(-1)?.status).toBe(
        "cancelled",
      );
    });
  });

  it("never asks again about a thread deleted while it was waiting", async () => {
    await withTestHarness(async (harness) => {
      const asks: string[] = [];
      const cancelled: string[] = [];
      installTarget({
        provision: (context) => {
          asks.push(context.thread.id);
          return { action: "wait", reason: "Starting container…" };
        },
        remove: async (context) => {
          cancelled.push(context.pathKey);
          return { status: "removed" };
        },
      });
      const { project } = seedTargetFixture(harness, "host-target-deleted");
      const created = await createTargetThread(harness, {
        projectId: project.id,
      });
      await vi.waitFor(() => {
        expect(scheduledEnvironmentProviderAskCount()).toBe(1);
      });

      const response = await harness.app.request(
        `/api/v1/threads/${created.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );
      expect(response.status).toBe(200);

      recheckEnvironmentProviderLaunches(harness.deps, PLUGIN_ID);
      await vi.waitFor(() => {
        expect(scheduledEnvironmentProviderAskCount()).toBe(0);
      });
      expect(new Set(asks)).toEqual(new Set([created.id]));
      await vi.waitFor(() => {
        expect(cancelled).toEqual([created.id]);
      });
    });
  });

  it("fires thread.unarchived and dispatches provider unarchive when a thread comes back", async () => {
    await withTestHarness(async (harness) => {
      const unarchived: string[] = [];
      setPluginThreadEventEmitter({
        emitThreadCreated: () => {},
        emitThreadActive: () => {},
        emitThreadIdle: () => {},
        emitThreadFailed: () => {},
        emitThreadArchived: () => {},
        emitThreadUnarchived: (thread) => {
          unarchived.push(thread.id);
        },
        emitThreadDeleted: () => {},
        emitMessageQueued: () => {},
        emitMessageDispatched: () => {},
        emitMessageCancelled: () => {},
        emitInteractionPending: () => {},
        emitTurnFailed: () => 0,
      });
      try {
        const { environment, host, project, session } = seedTargetFixture(
          harness,
          "host-target-unarchive",
        );
        registerTestHostRpcCapture(harness, {
          hostId: host.id,
          sessionId: session.id,
        });
        const thread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
          status: "idle",
        });
        const providerThreadId = "provider-unarchive";
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId,
          threadId: thread.id,
        });
        expect(
          (
            await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
              method: "POST",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await harness.app.request(
              `/api/v1/threads/${thread.id}/unarchive`,
              {
                method: "POST",
              },
            )
          ).status,
        ).toBe(200);
        expect(unarchived).toEqual([thread.id]);
        expect(
          listQueuedThreadCommands(harness, "thread.unarchive", thread.id),
        ).toEqual([
          expect.objectContaining({
            environmentId: environment.id,
            providerThreadId,
            providerId: thread.providerId,
            threadId: thread.id,
            type: "thread.unarchive",
          }),
        ]);
      } finally {
        setPluginThreadEventEmitter(undefined);
      }
    });
  });
});

it("resumes a provider launch and its original request after the in-memory context is lost", async () =>
  withTestHarness(async (harness) => {
    const { host, project } = seedTargetFixture(harness, "host-restart", {
      environmentProviderId: PROVIDER_ID,
    });
    let ready = false;
    installTarget({
      provision: () =>
        ready ? readyAt(host) : { action: "wait", reason: "Creating" },
    });
    const created = await createTargetThread(harness, {
      projectId: project.id,
    });
    await vi.waitFor(() =>
      expect(getEnvironmentLaunch(harness.db, created.id)?.phase).toBe(
        "creating",
      ),
    );
    const attempt = getEnvironmentLaunch(harness.db, created.id)?.attempt;
    const storedRequest = getEnvironmentLaunch(harness.db, created.id)?.request;
    expect(storedRequest).not.toBeNull();
    forgetAllActiveThreadProvisionContexts();
    ready = true;
    await advanceThreadProvisioning(harness.deps, { threadId: created.id });
    await vi.waitFor(() =>
      expect(getEnvironmentLaunch(harness.db, created.id)?.phase).toBe("ready"),
    );
    await advanceThreadProvisioning(harness.deps, { threadId: created.id });
    await vi.waitFor(() =>
      expect(getThread(harness.db, created.id)?.environmentId).not.toBeNull(),
    );
    expect(getEnvironmentLaunch(harness.db, created.id)?.attempt).toBe(attempt);
    expect(getThread(harness.db, created.id)?.status).not.toBe("error");
  }));

it("keeps an existing request waiting when its provider is not registered", async () =>
  withTestHarness(async (harness) => {
    installTarget(null);
    const { host, project } = seedTargetFixture(
      harness,
      "host-register-later",
      { environmentProviderId: PROVIDER_ID },
    );
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      status: "starting",
    });
    const context = createMetadataPendingContext({
      clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      environmentIntent: {
        type: "provider",
        environmentProviderId: PROVIDER_ID,
        machine: { type: "existing", hostId: host.id },
        inputs: null,
        selectionResolved: true,
        produced: null,
      },
      execution: {
        model: "requested-model",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      fork: null,
      input: textInput("Do the thing"),
      seedWithoutRun: false,
      titleProvided: true,
    });
    persistPendingProviderRequest(harness.db, thread.id, context.request);
    await advanceThreadProvisioning(harness.deps, { threadId: thread.id });
    await vi.waitFor(() =>
      expect(getEnvironmentLaunch(harness.db, thread.id)?.attempt).toBe(0),
    );
    forgetAllActiveThreadProvisionContexts();
    installTarget({ provision: () => readyAt(host) });
    await advanceThreadProvisioning(harness.deps, { threadId: thread.id });
    await vi.waitFor(
      () =>
        expect({
          thread: getThread(harness.db, thread.id),
          launch: getEnvironmentLaunch(harness.db, thread.id),
          events: provisioningEvents(harness, thread.id),
        }).toMatchObject({ thread: { environmentId: expect.any(String) } }),
      { timeout: 2000 },
    );
    expect(getEnvironmentLaunch(harness.db, thread.id)?.attempt).toBe(1);
  }));
