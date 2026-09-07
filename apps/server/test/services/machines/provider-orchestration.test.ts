import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createProjectSource,
  createEnvironment,
  getDefaultProjectSource,
  getEnvironment,
  getHost,
  getMachineLaunch,
  listProjectSourcesByProjectIds,
  threads,
  updateHost,
  upsertMachineLaunch,
} from "@bb/db";
import { hostSchema, type JsonValue, type Project } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import {
  defineRpcContract,
  type PluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk";
import {
  validatePluginEnvironmentProviderDeclaration,
  validatePluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { z } from "zod";
import {
  askMachineLaunch,
  cancelMachineLaunch,
  createMachine,
  prepareMachineProviderSelection,
  requestMachineRemoval,
  sweepMachineLifecycles,
  sweepProviderMachine,
} from "../../../src/services/machines/provider-orchestration.js";
import { setPluginMachineProviderBridge } from "../../../src/services/plugins/plugin-machine-provider-registry.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import { registerTestHostRpcCapture } from "../../helpers/commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import { ensureHostSessionReadyForWork } from "../../../src/services/hosts/host-lifecycle.js";
import { callPluginHostRpc } from "../../../src/services/plugins/plugin-host-rpc.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { stubHostArtifact } from "../../helpers/provider-registry.js";

const lifecycleHostContract = defineRpcContract({
  probe: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

function installMachineProvider(declaration: PluginMachineProviderDeclaration) {
  const record = {
    pluginId: "test-machine-plugin",
    provider: validatePluginMachineProviderDeclaration(declaration),
  };
  setPluginMachineProviderBridge({
    listMachineProviders: () => [record],
    getMachineProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_pluginId, _label, run) => {
      try {
        return { ok: true as const, value: await run() };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: 10_000,
  });
  return record;
}

function machineDeclaration(
  hostId: string,
  overrides: Partial<PluginMachineProviderDeclaration> = {},
): PluginMachineProviderDeclaration {
  return {
    id: "test-machine",
    displayName: "Test machine",
    policy: {
      idleSuspendMs: null,
      retire: { after: "never" },
      removeRetryMs: 10,
    },
    create: async ({ key }) => ({
      status: "created",
      hostId,
      resource: { key },
    }),
    remove: async () => ({ status: "removed" }),
    ...overrides,
  };
}

function adoptMachine(
  harness: TestAppHarness,
  hostId: string,
  resource: JsonValue = { machine: "resource" },
): void {
  updateHost(harness.db, harness.hub, hostId, {
    machineProviderId: "test-machine",
    machineProviderSelection: { inputs: null },
    phase: "active",
    resource,
  });
}

afterEach(() => {
  vi.useRealTimers();
  setPluginMachineProviderBridge(undefined);
  setPluginEnvironmentProviderBridge(undefined);
});

describe("core machine provider orchestration", () => {
  it("restarts a persisted create with the same idempotency key after a server crash", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host_machine" });
      const calls: Array<{ attempt: number; key: string }> = [];
      const record = installMachineProvider(
        machineDeclaration(host.id, {
          create: async ({ attempt, key }) => {
            calls.push({ attempt, key });
            return {
              status: "created",
              hostId: host.id,
              resource: { key },
            };
          },
        }),
      );
      upsertMachineLaunch(harness.db, {
        key: "durable-machine-key",
        providerId: record.provider.id,
        projectId: null,
        inputs: null,
        attempt: 4,
        phase: "creating",
        startedAt: Date.now() - 1_000,
        failedAt: null,
        failure: null,
        message: null,
        transientFailures: 0,
        hostId: null,
        resource: null,
        stepText: "Creating Test machine…",
        pendingLog: "",
        cancelPending: false,
      });

      expect(
        askMachineLaunch(harness.deps, {
          key: "durable-machine-key",
          record,
          projectId: null,
          inputs: null,
        }).action,
      ).toBe("wait");
      await expect
        .poll(() => getMachineLaunch(harness.db, "durable-machine-key")?.phase)
        .toBe("ready");
      expect(calls).toEqual([{ attempt: 4, key: "durable-machine-key" }]);
      expect(getHost(harness.db, host.id)).toMatchObject({
        machineProviderId: "test-machine",
        resource: { key: "durable-machine-key" },
      });
    }));

  it("parses inputs once and persists the parsed value on the launch and machine", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host_inputs" });
      const seen: JsonValue[] = [];
      installMachineProvider(
        machineDeclaration(host.id, {
          inputs: z.object({ target: z.string().trim().min(1) }).strict(),
          create: async ({ inputs, key }) => {
            seen.push(z.object({ target: z.string() }).strict().parse(inputs));
            return {
              status: "created",
              hostId: host.id,
              resource: { key },
            };
          },
        }),
      );

      await createMachine(harness.deps, {
        key: "inputs-key",
        machineProviderId: "test-machine",
        projectId: null,
        inputs: { target: "  staging  " },
      });
      expect(seen).toEqual([{ target: "staging" }]);
      expect(getMachineLaunch(harness.db, "inputs-key")?.inputs).toEqual({
        target: "staging",
      });
      expect(getHost(harness.db, host.id)?.machineProviderSelection).toEqual({
        inputs: { target: "staging" },
      });
    }));

  it("rejects an unknown machine provider", async () =>
    withTestHarness(async (harness) => {
      await expect(
        prepareMachineProviderSelection(harness.deps, {
          machineProviderId: "missing-machine",
          projectId: null,
          inputs: null,
        }),
      ).rejects.toThrow('Unknown machine provider "missing-machine"');
    }));

  it("allows a standalone machine when project facts only constrain project creation", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host_standalone",
      });
      const contexts: Array<{
        project: Project | null;
        gitRemote: string | null;
      }> = [];
      installMachineProvider(
        machineDeclaration(host.id, {
          requires: { gitRemote: true },
          validate: ({ project, gitRemote }) => {
            contexts.push({ project, gitRemote });
            return { action: "accept" };
          },
        }),
      );

      await expect(
        prepareMachineProviderSelection(harness.deps, {
          machineProviderId: "test-machine",
          projectId: null,
          inputs: null,
        }),
      ).resolves.toMatchObject({ inputs: null });
      expect(contexts).toEqual([{ project: null, gitRemote: null }]);
    }));

  it("recovers and removes a machine when creation is cancelled", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host_cancel" });
      const calls: string[] = [];
      const record = installMachineProvider(
        machineDeclaration(host.id, {
          create: ({ key, signal }) =>
            new Promise((resolve, reject) => {
              calls.push(`create:${key}`);
              if (calls.length > 1) {
                resolve({
                  status: "created",
                  hostId: host.id,
                  resource: { key },
                });
                return;
              }
              signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            }),
          remove: async ({ resource }) => {
            calls.push(`remove:${JSON.stringify(resource)}`);
            return { status: "removed" };
          },
        }),
      );

      askMachineLaunch(harness.deps, {
        key: "cancel-key",
        record,
        projectId: null,
        inputs: null,
      });
      await cancelMachineLaunch(harness.deps, "cancel-key");

      expect(calls).toEqual([
        "create:cancel-key",
        "create:cancel-key",
        'remove:{"key":"cancel-key"}',
      ]);
      expect(getMachineLaunch(harness.db, "cancel-key")).toMatchObject({
        phase: "cancelled",
        cancelPending: false,
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        phase: "destroyed",
      });
    }));

  it("keeps cancellation pending after a transient recovery failure and retries on the next sweep", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host_cancel_retry",
      });
      const calls: string[] = [];
      let attempts = 0;
      const record = installMachineProvider(
        machineDeclaration(host.id, {
          create: async ({ key }) => {
            attempts += 1;
            calls.push(`create:${attempts}`);
            return attempts === 1
              ? {
                  status: "failed",
                  failure: "transient",
                  message: "Modal lookup timed out",
                }
              : {
                  status: "created",
                  hostId: host.id,
                  resource: { key },
                };
          },
          remove: async () => {
            calls.push("remove");
            return { status: "removed" };
          },
        }),
      );
      upsertMachineLaunch(harness.db, {
        key: "cancel-retry-key",
        providerId: record.provider.id,
        projectId: null,
        inputs: null,
        attempt: 1,
        phase: "cancelled",
        startedAt: Date.now(),
        failedAt: null,
        failure: null,
        message: null,
        transientFailures: 0,
        hostId: null,
        resource: null,
        stepText: "Cancelling Test machine…",
        pendingLog: "",
        cancelPending: true,
      });

      await sweepMachineLifecycles(harness.deps);
      expect(calls).toEqual(["create:1"]);
      expect(getMachineLaunch(harness.db, "cancel-retry-key")).toMatchObject({
        phase: "cancelled",
        cancelPending: true,
      });

      await sweepMachineLifecycles(harness.deps);
      expect(calls).toEqual(["create:1", "create:2", "remove"]);
      expect(getMachineLaunch(harness.db, "cancel-retry-key")).toMatchObject({
        phase: "cancelled",
        cancelPending: false,
      });
    }));

  it("starts a new attempt when a ready launch points to a destroyed machine", async () =>
    withTestHarness(async (harness) => {
      const { host: destroyedHost } = seedHostSession(harness.deps, {
        id: "host_destroyed_launch",
      });
      const { host: replacementHost } = seedHostSession(harness.deps, {
        id: "host_replacement_launch",
      });
      updateHost(harness.db, harness.hub, destroyedHost.id, {
        destroyedAt: Date.now(),
        phase: "destroyed",
      });
      const calls: number[] = [];
      const record = installMachineProvider(
        machineDeclaration(replacementHost.id, {
          create: async ({ attempt, key }) => {
            calls.push(attempt);
            return {
              status: "created",
              hostId: replacementHost.id,
              resource: { key },
            };
          },
        }),
      );
      upsertMachineLaunch(harness.db, {
        key: "ready-destroyed-key",
        providerId: record.provider.id,
        projectId: null,
        inputs: null,
        attempt: 1,
        phase: "ready",
        startedAt: Date.now() - 1_000,
        failedAt: null,
        failure: null,
        message: null,
        transientFailures: 0,
        hostId: destroyedHost.id,
        resource: { key: "ready-destroyed-key" },
        stepText: "Ready",
        pendingLog: "",
        cancelPending: false,
      });

      expect(
        askMachineLaunch(harness.deps, {
          key: "ready-destroyed-key",
          record,
          projectId: null,
          inputs: null,
        }).action,
      ).toBe("wait");
      await vi.waitFor(() => {
        expect(calls).toEqual([2]);
        expect(
          getMachineLaunch(harness.db, "ready-destroyed-key"),
        ).toMatchObject({
          phase: "ready",
          attempt: 2,
          hostId: replacementHost.id,
        });
      });
    }));

  it("cancels a pending machine creation when its thread is deleted", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host_deleted_launch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/deleted-machine-launch",
      });
      const thread = seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
        status: "starting",
      });
      const calls: string[] = [];
      const record = installMachineProvider(
        machineDeclaration(host.id, {
          create: ({ key, signal }) =>
            new Promise((resolve, reject) => {
              calls.push(`create:${key}`);
              if (calls.length > 1) {
                resolve({
                  status: "created",
                  hostId: host.id,
                  resource: { key },
                });
                return;
              }
              signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            }),
          remove: async ({ resource }) => {
            calls.push(`remove:${JSON.stringify(resource)}`);
            return { status: "removed" };
          },
        }),
      );
      askMachineLaunch(harness.deps, {
        key: thread.id,
        record,
        projectId: project.id,
        inputs: null,
      });
      await vi.waitFor(() => {
        expect(calls).toEqual([`create:${thread.id}`]);
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(calls).toEqual([
          `create:${thread.id}`,
          `create:${thread.id}`,
          `remove:{\"key\":\"${thread.id}\"}`,
        ]);
      });
      expect(getMachineLaunch(harness.db, thread.id)).toMatchObject({
        phase: "cancelled",
        cancelPending: false,
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        phase: "destroyed",
      });
    }));

  it("suspends after every live thread has been idle for the policy delay", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const { host } = seedHostSession(harness.deps, { id: "host_suspend" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/suspend",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/suspend",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      let suspends = 0;
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async () => {
            suspends += 1;
            return { resource: { snapshot: "snap-1" } };
          },
          resume: async ({ resource }) => ({ resource }),
        }),
      );
      adoptMachine(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);
      expect(suspends).toBe(1);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "suspended",
        suspendedAt: 10_000,
        resource: { snapshot: "snap-1" },
      });
    }));

  it("allows a suspend callback to call its own host RPC", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const { host, session } = seedHostSession(harness.deps, {
        id: "host_suspend_rpc",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "plugin.host.call") {
            throw new Error(`Unexpected RPC ${request.command.type}`);
          }
          return { ok: true, result: { output: { ok: true } } };
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/suspend-rpc",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/suspend-rpc",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async ({ hostId, resource, signal }) => {
            await callPluginHostRpc(harness.deps, {
              pluginId: "test-machine-plugin",
              contract: lifecycleHostContract,
              method: "probe",
              input: {},
              hostId,
              signal,
              artifact: stubHostArtifact("test-machine-plugin"),
            });
            return { resource };
          },
          resume: async ({ resource }) => ({ resource }),
        }),
      );
      adoptMachine(harness, host.id);

      const sweep = sweepProviderMachine(harness.deps, host.id);
      const outcome = await Promise.race([
        sweep.then(() => "completed" as const),
        new Promise<"blocked">((resolve) =>
          setImmediate(() => resolve("blocked")),
        ),
      ]);

      expect(outcome).toBe("completed");
      expect(responder.requests).toHaveLength(1);
    }));

  it("persists a suspension checkpoint even when the provider crashes afterward", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const { host, session } = seedHostSession(harness.deps, {
        id: "host_suspend_checkpoint",
      });
      const socket = registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/suspend-checkpoint",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/suspend-checkpoint",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      let resumes = 0;
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async (context) => {
            context.checkpoint({ snapshot: "snap-recoverable" });
            harness.hub.unregisterDaemon(session.id);
            throw new Error("server crashed after checkpoint");
          },
          resume: async ({ resource }) => {
            resumes += 1;
            harness.hub.registerDaemon(session.id, host.id, socket);
            const checkpoint = z
              .object({ snapshot: z.string() })
              .strict()
              .parse(resource);
            return { resource: { ...checkpoint, recovered: true } };
          },
        }),
      );
      adoptMachine(harness, host.id, { sandbox: "live" });

      await expect(sweepProviderMachine(harness.deps, host.id)).rejects.toThrow(
        "server crashed after checkpoint",
      );
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "suspending",
        resource: { snapshot: "snap-recoverable" },
      });
      harness.db
        .update(threads)
        .set({ status: "error", updatedAt: 10_001 })
        .where(eq(threads.id, thread.id))
        .run();

      await expect(
        ensureHostSessionReadyForWork(harness.deps, { hostId: host.id }),
      ).resolves.toMatchObject({ hostId: host.id });
      expect(resumes).toBe(1);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "active",
        resource: { snapshot: "snap-recoverable", recovered: true },
      });
      updateHost(harness.db, harness.hub, host.id, {
        phase: "suspending",
        resource: { snapshot: "snap-sweep-recovery" },
      });
      harness.hub.unregisterDaemon(session.id);

      await sweepProviderMachine(harness.deps, host.id);
      expect(resumes).toBe(2);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "active",
        resource: { snapshot: "snap-sweep-recovery", recovered: true },
      });
    }));

  it("recovers a persisted suspending machine from its surviving resource", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host_surviving_suspend",
      });
      const resources: JsonValue[] = [];
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 1,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async ({ resource }) => ({ resource }),
          resume: async ({ resource }) => {
            resources.push(resource);
            return { resource: { sandbox: "surviving", resumed: true } };
          },
        }),
      );
      adoptMachine(harness, host.id, {
        sandbox: "surviving",
        snapshot: null,
      });
      updateHost(harness.db, harness.hub, host.id, {
        phase: "suspending",
      });

      await sweepProviderMachine(harness.deps, host.id);

      expect(resources).toEqual([{ sandbox: "surviving", snapshot: null }]);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "active",
        resource: { sandbox: "surviving", resumed: true },
      });
    }));

  it("serializes removal after an in-flight suspension", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const { host } = seedHostSession(harness.deps, {
        id: "host_suspend_remove",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/suspend-remove",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/suspend-remove",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      const suspendStarted = createDeferredPromise<void>();
      const suspendRelease = createDeferredPromise<void>();
      const removeStarted = createDeferredPromise<void>();
      const removedResources: JsonValue[] = [];
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async () => {
            suspendStarted.resolve();
            await suspendRelease.promise;
            return { resource: { snapshot: "snap-before-remove" } };
          },
          resume: async ({ resource }) => ({ resource }),
          remove: async ({ resource }) => {
            removedResources.push(resource);
            removeStarted.resolve();
            return { status: "removed" };
          },
        }),
      );
      adoptMachine(harness, host.id, { sandbox: "live" });

      const suspendSweep = sweepProviderMachine(harness.deps, host.id);
      await suspendStarted.promise;
      harness.db
        .update(threads)
        .set({ archivedAt: 10_000 })
        .where(eq(threads.id, thread.id))
        .run();
      expect(requestMachineRemoval(harness.deps, host.id)).toBe(true);
      const removalSweep = sweepProviderMachine(harness.deps, host.id);
      const order = await Promise.race([
        removeStarted.promise.then(() => "removed" as const),
        new Promise<"waiting">((resolve) =>
          setImmediate(() => resolve("waiting")),
        ),
      ]);
      suspendRelease.resolve();
      await Promise.all([suspendSweep, removalSweep]);

      expect(order).toBe("waiting");
      expect(removedResources).toEqual([{ snapshot: "snap-before-remove" }]);
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        phase: "destroyed",
        resource: null,
        teardownStatus: "removed",
      });
    }));

  it("ignores a suspension result that finishes after the machine was destroyed", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const { host } = seedHostSession(harness.deps, {
        id: "host_stale_suspend_completion",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stale-suspend-completion",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/stale-suspend-completion",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      const suspendStarted = createDeferredPromise<void>();
      const suspendRelease = createDeferredPromise<void>();
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async () => {
            suspendStarted.resolve();
            await suspendRelease.promise;
            return { resource: { snapshot: "stale-snapshot" } };
          },
          resume: async ({ resource }) => ({ resource }),
        }),
      );
      adoptMachine(harness, host.id, { sandbox: "live" });

      const suspendSweep = sweepProviderMachine(harness.deps, host.id);
      await suspendStarted.promise;
      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: 10_000,
        phase: "destroyed",
        resource: null,
        suspendedAt: null,
        teardownStatus: "removed",
      });
      suspendRelease.resolve();
      await suspendSweep;

      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: 10_000,
        phase: "destroyed",
        resource: null,
        suspendedAt: null,
        teardownStatus: "removed",
      });
    }));

  it("waits for an in-flight suspension and resumes before dispatching new work", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const { host, session } = seedHostSession(harness.deps, {
        id: "host_suspend_race",
      });
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/suspend-race",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/suspend-race",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      const suspendStarted = createDeferredPromise<void>();
      const suspendRelease = createDeferredPromise<void>();
      let resumes = 0;
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async () => {
            suspendStarted.resolve();
            await suspendRelease.promise;
            return { resource: { snapshot: "snap-race" } };
          },
          resume: async () => {
            resumes += 1;
            return { resource: { sandbox: "resumed" } };
          },
        }),
      );
      adoptMachine(harness, host.id, { sandbox: "live" });

      const sweep = sweepProviderMachine(harness.deps, host.id);
      await suspendStarted.promise;
      let dispatched = false;
      const admission = ensureHostSessionReadyForWork(harness.deps, {
        hostId: host.id,
      }).then(() => {
        dispatched = true;
      });
      await Promise.resolve();
      expect(dispatched).toBe(false);
      suspendRelease.resolve();

      await Promise.all([sweep, admission]);
      expect(resumes).toBe(1);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "active",
        suspendedAt: null,
        resource: { sandbox: "resumed" },
      });
    }));

  it("resumes a suspended provider machine when a message is sent", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host_resume",
      });
      const socket = registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/resume",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/resume",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-resume",
        threadId: thread.id,
      });
      let resumes = 0;
      let observedProgress: string | null = null;
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 1,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async ({ resource }) => ({ resource }),
          resume: async ({ report }) => {
            resumes += 1;
            report.step("Restoring the test machine…");
            const hosts = hostSchema
              .array()
              .parse(await (await harness.app.request("/api/v1/hosts")).json());
            observedProgress =
              hosts.find((candidate) => candidate.id === host.id)?.lifecycle
                .progress ?? null;
            harness.hub.registerDaemon(session.id, host.id, socket);
            return { resource: { sandbox: "resumed" } };
          },
        }),
      );
      adoptMachine(harness, host.id, { snapshot: "snap-1" });
      updateHost(harness.db, harness.hub, host.id, {
        phase: "suspended",
        suspendedAt: Date.now(),
      });
      harness.hub.unregisterDaemon(session.id);

      await expect(
        sendThreadMessage(harness.deps, {
          environment,
          payload: {
            input: textInput("resume this machine"),
            mode: "start",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
          trigger: "user",
        }),
      ).resolves.toBeUndefined();
      expect(resumes).toBe(1);
      expect(observedProgress).toBe("Restoring the test machine…");
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "active",
        suspendedAt: null,
        resource: { sandbox: "resumed" },
      });
    }));

  it("retires after the last thread and cascades environment removal first", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(20_000);
      const { host } = seedHostSession(harness.deps, { id: "host_retire" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/retire",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/retire",
        providerOwnsPath: true,
        status: "ready",
        environmentProvider: {
          environmentProviderId: "test-environment",
          instanceKey: "retire-environment",
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ archivedAt: 20_000 })
        .where(eq(threads.id, thread.id))
        .run();
      const order: string[] = [];
      const environmentProvider = validatePluginEnvironmentProviderDeclaration({
        id: "test-environment",
        displayName: "Test environment",
        create: async () => ({
          status: "created",
          path: "/tmp/retire",
          ownsPath: true,
        }),
        remove: async () => {
          order.push("environment");
          return { status: "removed" };
        },
      });
      setPluginEnvironmentProviderBridge({
        listEnvironmentProviders: () => [
          {
            pluginId: "test-environment-plugin",
            provider: environmentProvider,
          },
        ],
        getEnvironmentProvider: (id) =>
          id === environmentProvider.id
            ? {
                pluginId: "test-environment-plugin",
                provider: environmentProvider,
              }
            : undefined,
        invokeProvider: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: null,
            retire: { after: "last-thread", graceMs: 5_000 },
            removeRetryMs: 10,
          },
          remove: async () => {
            order.push("machine");
            return { status: "removed" };
          },
        }),
      );
      adoptMachine(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "retiring",
        retireAt: 25_000,
      });
      expect(order).toEqual([]);
      vi.setSystemTime(25_001);
      await sweepProviderMachine(harness.deps, host.id);
      expect(order).toEqual(["environment", "machine"]);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("resumes a suspended retiring machine for its environment cascade without clearing retirement", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(20_000);
      const { host, session } = seedHostSession(harness.deps, {
        id: "host_suspended_retire",
      });
      const socket = registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/suspended-retire",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/suspended-retire",
        providerOwnsPath: true,
        status: "ready",
        environmentProvider: {
          environmentProviderId: "test-environment",
          instanceKey: "suspended-retire-environment",
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ archivedAt: 20_000 })
        .where(eq(threads.id, thread.id))
        .run();
      let environmentRemovalPhase: string | null = null;
      const environmentProvider = validatePluginEnvironmentProviderDeclaration({
        id: "test-environment",
        displayName: "Test environment",
        create: async () => ({
          status: "created",
          path: "/tmp/suspended-retire",
          ownsPath: true,
        }),
        remove: async () => {
          environmentRemovalPhase = getHost(harness.db, host.id)?.phase ?? null;
          return harness.hub.hasDaemonForHost(host.id)
            ? { status: "removed" }
            : { status: "failed", message: "Host is not connected" };
        },
      });
      setPluginEnvironmentProviderBridge({
        listEnvironmentProviders: () => [
          {
            pluginId: "test-environment-plugin",
            provider: environmentProvider,
          },
        ],
        getEnvironmentProvider: (id) =>
          id === environmentProvider.id
            ? {
                pluginId: "test-environment-plugin",
                provider: environmentProvider,
              }
            : undefined,
        invokeProvider: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      let removes = 0;
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 1,
            retire: { after: "last-thread", graceMs: 0 },
            removeRetryMs: 10,
          },
          suspend: async ({ resource }) => ({ resource }),
          resume: async () => {
            harness.hub.registerDaemon(session.id, host.id, socket);
            return {
              resource: { snapshot: "snap-retire", resumed: true },
            };
          },
          remove: async () => {
            removes += 1;
            return { status: "removed" };
          },
        }),
      );
      adoptMachine(harness, host.id, { snapshot: "snap-retire" });
      updateHost(harness.db, harness.hub, host.id, {
        phase: "suspended",
        suspendedAt: 19_000,
      });
      harness.hub.unregisterDaemon(session.id);

      await sweepProviderMachine(harness.deps, host.id);
      expect(environmentRemovalPhase).toBe("retiring");
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
      });
      expect(removes).toBe(1);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("removes a suspended retiring machine directly when no environment needs cleanup", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(20_000);
      const { host, session } = seedHostSession(harness.deps, {
        id: "host_suspended_retire_without_environment",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/retire-without-host-cleanup",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/retire-without-host-cleanup",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: {
          environmentProviderId: "test-attached-environment",
          instanceKey: "attached-environment",
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
      });
      let environmentRemoves = 0;
      const environmentProvider = validatePluginEnvironmentProviderDeclaration({
        id: "test-attached-environment",
        displayName: "Test attached environment",
        create: async () => ({
          status: "created",
          path: "/tmp/retire-without-host-cleanup",
          ownsPath: false,
        }),
        remove: async () => {
          environmentRemoves += 1;
          return { status: "removed" };
        },
      });
      setPluginEnvironmentProviderBridge({
        listEnvironmentProviders: () => [
          {
            pluginId: "test-attached-environment-plugin",
            provider: environmentProvider,
          },
        ],
        getEnvironmentProvider: (id) =>
          id === environmentProvider.id
            ? {
                pluginId: "test-attached-environment-plugin",
                provider: environmentProvider,
              }
            : undefined,
        invokeProvider: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      let resumes = 0;
      let removes = 0;
      installMachineProvider(
        machineDeclaration(host.id, {
          policy: {
            idleSuspendMs: 1,
            retire: { after: "last-thread", graceMs: 0 },
            removeRetryMs: 10,
          },
          suspend: async ({ resource }) => ({ resource }),
          resume: async () => {
            resumes += 1;
            throw new Error("snapshot restoration has no capacity");
          },
          remove: async () => {
            removes += 1;
            return { status: "removed" };
          },
        }),
      );
      adoptMachine(harness, host.id, { snapshot: "snap-remove-directly" });
      updateHost(harness.db, harness.hub, host.id, {
        phase: "suspended",
        suspendedAt: 19_000,
      });
      harness.hub.unregisterDaemon(session.id);

      await expect(
        sweepProviderMachine(harness.deps, host.id),
      ).resolves.toBeUndefined();

      expect(resumes).toBe(0);
      expect(environmentRemoves).toBe(1);
      expect(removes).toBe(1);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        status: "destroyed",
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("records a machine lifecycle failure and continues sweeping later machines", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(30_000);
      const { host: failingHost } = seedHostSession(harness.deps, {
        id: "host_a_failing_suspend",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: failingHost.id,
        path: "/tmp/failing-suspend",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: failingHost.id,
        path: "/tmp/failing-suspend",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ updatedAt: 1_000 })
        .where(eq(threads.id, thread.id))
        .run();
      const { host: removableHost } = seedHostSession(harness.deps, {
        id: "host_b_removable",
      });
      let removes = 0;
      installMachineProvider(
        machineDeclaration(failingHost.id, {
          policy: {
            idleSuspendMs: 5_000,
            retire: { after: "never" },
            removeRetryMs: 10,
          },
          suspend: async ({ hostId, resource }) => {
            if (hostId === failingHost.id) {
              throw new Error("snapshot service unavailable");
            }
            return { resource };
          },
          resume: async ({ resource }) => ({ resource }),
          remove: async () => {
            removes += 1;
            return { status: "removed" };
          },
        }),
      );
      adoptMachine(harness, failingHost.id);
      adoptMachine(harness, removableHost.id);
      expect(requestMachineRemoval(harness.deps, removableHost.id)).toBe(true);

      await expect(
        sweepMachineLifecycles(harness.deps),
      ).resolves.toBeUndefined();
      expect(getHost(harness.db, failingHost.id)).toMatchObject({
        phase: "suspending",
        teardownStatus: "failed",
        teardownMessage: "snapshot service unavailable",
      });
      expect(removes).toBe(1);
      expect(getHost(harness.db, removableHost.id)).toMatchObject({
        phase: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("keeps a never-policy machine until the user removes it", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host_never" });
      let removes = 0;
      installMachineProvider(
        machineDeclaration(host.id, {
          remove: async () => {
            removes += 1;
            return { status: "removed" };
          },
        }),
      );
      adoptMachine(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);
      expect(removes).toBe(0);
      expect(getHost(harness.db, host.id)?.phase).toBe("active");
      expect(requestMachineRemoval(harness.deps, host.id)).toBe(true);
      await sweepProviderMachine(harness.deps, host.id);
      expect(removes).toBe(1);
      expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
    }));

  it("removes destroyed-machine project sources and selects a surviving default", async () =>
    withTestHarness(async (harness) => {
      const { host: removedHost } = seedHostSession(harness.deps, {
        id: "host_removed_source",
      });
      const { host: survivingHost } = seedHostSession(harness.deps, {
        id: "host_surviving_source",
      });
      const { project, source: removedSource } = seedProjectWithSource(
        harness.deps,
        {
          hostId: removedHost.id,
          path: "/tmp/removed-source",
        },
      );
      const survivingSource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        hostId: survivingHost.id,
        path: "/tmp/surviving-source",
        type: "local_path",
      });
      installMachineProvider(machineDeclaration(removedHost.id));
      adoptMachine(harness, removedHost.id);

      expect(requestMachineRemoval(harness.deps, removedHost.id)).toBe(true);
      await sweepProviderMachine(harness.deps, removedHost.id);

      expect(listProjectSourcesByProjectIds(harness.db, [project.id])).toEqual([
        expect.objectContaining({
          id: survivingSource.id,
          hostId: survivingHost.id,
          isDefault: true,
        }),
      ]);
      expect(getDefaultProjectSource(harness.db, project.id)?.id).toBe(
        survivingSource.id,
      );
      expect(
        listProjectSourcesByProjectIds(harness.db, [project.id]).some(
          (source) => source.id === removedSource.id,
        ),
      ).toBe(false);
    }));
});
