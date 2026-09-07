import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createEnvironment,
  environments,
  getEnvironment,
  getEnvironmentLaunch,
  getProject,
  pruneDestroyedEnvironments,
  saveEnvironmentLaunch,
  threads,
  updateThread,
} from "@bb/db";
import type { JsonValue } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import {
  askProviderLaunch,
  attachProviderLaunch,
  cancelProviderLaunch,
  sweepProviderEnvironment,
} from "../../../src/services/environments/provider-orchestration.js";
import { toEnvironmentResponse } from "../../../src/services/environments/environment-response.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  advanceProjectDeletion,
  beginProjectDeletion,
} from "../../../src/services/projects/project-deletion.js";
import { runPeriodicSweeps } from "../../../src/services/system/periodic-sweeps.js";
import { toThreadResponseFromThread } from "../../../src/services/threads/thread-runtime-display.js";
import { resolveProducedEnvironmentPlacement } from "../../../src/services/threads/thread-environment-placement.js";
import type { TestEnvironmentProviderContext } from "../../helpers/provider-decisions.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

function setup(
  harness: TestAppHarness,
  overrides: Partial<PluginEnvironmentProviderDeclaration> = {},
) {
  const { host } = seedHostSession(harness.deps, { id: "host_test" });
  const { project, source } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/project",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    status: "starting",
  });
  const record = {
    pluginId: "test",
    provider: validatePluginEnvironmentProviderDeclaration({
      id: "test-provider",
      displayName: "Test",
      create: async () => ({
        status: "created",
        path: `/tmp/${thread.id}`,
        ownsPath: true,
      }),
      remove: async () => ({ status: "removed" }),
      ...overrides,
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_id, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  const context: TestEnvironmentProviderContext = {
    thread: toThreadResponseFromThread(harness.deps, { thread }),
    project,
    host: makeHost({ id: host.id, name: host.name }),
    machine: { type: "existing", hostId: host.id },
    projectCheckout: null,
    gitRemote: null,
    inputs: null,
    suggestedBranchName: "bb/test",
    environment: null,
  };
  const row = () => {
    const value = getEnvironmentLaunch(harness.db, thread.id);
    if (value === null) throw new Error("Missing launch");
    return value;
  };
  const ask = () => askProviderLaunch(harness.deps, record, context, null);
  const settled = async () =>
    expect.poll(() => row().phase).not.toBe("creating");
  const attach = () => {
    const launch = row();
    if (launch.hostId === null || launch.path === null) {
      throw new Error("Launch is not ready");
    }
    const environment = createEnvironment(harness.db, harness.hub, {
      projectId: project.id,
      hostId: launch.hostId,
      path: launch.path,
      providerOwnsPath: launch.ownsPath,
      status: "ready",
      environmentProvider: {
        environmentProviderId: record.provider.id,
        selection: launch.selection,
        instanceKey: launch.pathKey,
      },
    });
    attachProviderLaunch(harness.db, thread.id, environment.id);
    return environment.id;
  };
  return { ask, attach, context, host, record, row, settled, source, thread };
}

function pendingUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("Environment creation aborted")),
      { once: true },
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
  setPluginEnvironmentProviderBridge(undefined);
});

describe("core environment orchestration", () => {
  it("runs one long create call and records the ready result", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness);
      expect(fixture.ask()).toMatchObject({
        action: "wait",
        reason: "Preparing Test…",
      });
      await fixture.settled();
      expect(fixture.ask()).toMatchObject({
        action: "ready",
        environment: { path: `/tmp/${fixture.thread.id}` },
      });
      const environmentId = fixture.attach();
      expect(fixture.row().environmentId).toBe(environmentId);
    }));

  it("re-runs a persisted creating attempt with the same path key", async () =>
    withTestHarness(async (harness) => {
      const calls: Array<{ attempt: number; pathKey: string }> = [];
      const fixture = setup(harness, {
        create: async (context) => {
          calls.push({ attempt: context.attempt, pathKey: context.pathKey });
          return {
            status: "created",
            path: `/tmp/${context.pathKey}`,
            ownsPath: true,
          };
        },
      });
      saveEnvironmentLaunch(harness.db, {
        threadId: fixture.thread.id,
        providerId: fixture.record.provider.id,
        attempt: 7,
        phase: "creating",
        startedAt: Date.now() - 1_000,
        failedAt: null,
        failure: null,
        message: null,
        transientFailures: 0,
        pathKey: "durable-path-key",
        hostId: null,
        path: null,
        ownsPath: true,
        mergeBaseBranch: null,
        resource: null,
        stepText: "Preparing Test…",
        pendingLog: "",
        replacedEnvironmentId: null,
        environmentId: null,
        selection: {
          machine: { type: "existing", hostId: fixture.host.id },
          inputs: null,
        },
        cancelPending: false,
        request: null,
      });

      expect(fixture.ask().action).toBe("wait");
      await fixture.settled();
      expect(calls).toEqual([{ attempt: 7, pathKey: "durable-path-key" }]);
      expect(fixture.row()).toMatchObject({
        attempt: 7,
        pathKey: "durable-path-key",
        phase: "ready",
      });
    }));

  it("persists progress reported from inside create", async () =>
    withTestHarness(async (harness) => {
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = setup(harness, {
        create: async (context) => {
          context.report.step("Cloning repository");
          context.report.log("clone output");
          await waiting;
          return {
            status: "created",
            path: "/tmp/progress",
            ownsPath: true,
          };
        },
      });
      fixture.ask();
      await expect
        .poll(() => fixture.ask())
        .toMatchObject({ reason: "Cloning repository", log: "clone output" });
      expect(fixture.ask()).toMatchObject({ log: "" });
      release();
      await fixture.settled();
    }));

  it("aborts create at its timeout and records a transient failure", async () =>
    withTestHarness(async (harness) => {
      let aborted = false;
      const fixture = setup(harness, {
        policy: { createTimeoutMs: 5, transientRetryLimit: 0 },
        create: async (context) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return pendingUntilAbort(context.signal);
        },
      });
      fixture.ask();
      await fixture.settled();
      expect(aborted).toBe(true);
      expect(fixture.row()).toMatchObject({
        phase: "failed",
        failure: "transient",
        transientFailures: 1,
        message: "Environment creation timed out after 5 ms.",
      });
    }));

  it("aborts create before removing everything under its path key", async () =>
    withTestHarness(async (harness) => {
      const events: string[] = [];
      const fixture = setup(harness, {
        create: async (context) => {
          events.push(`create:${context.pathKey}`);
          context.signal.addEventListener("abort", () => events.push("abort"));
          return pendingUntilAbort(context.signal);
        },
        remove: async (context) => {
          events.push(`remove:${context.pathKey}`);
          expect(context.environment).toBeNull();
          expect(context.path).toBeNull();
          return { status: "removed" };
        },
      });
      fixture.ask();
      await expect.poll(() => events).toHaveLength(1);
      await cancelProviderLaunch(harness.deps, fixture.thread.id);
      expect(events).toEqual([
        `create:${fixture.thread.id}`,
        "abort",
        `remove:${fixture.thread.id}`,
      ]);
      expect(fixture.row()).toMatchObject({
        phase: "cancelled",
        cancelPending: false,
      });
    }));

  it("waits for an aborted create to stop before removing its path key", async () =>
    withTestHarness(async (harness) => {
      const events: string[] = [];
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = setup(harness, {
        create: async (context) => {
          events.push("create");
          context.signal.addEventListener("abort", () => events.push("abort"));
          await waiting;
          events.push("create-stopped");
          return {
            status: "created",
            path: `/tmp/${context.pathKey}`,
            ownsPath: true,
          };
        },
        remove: async () => {
          events.push("remove");
          return { status: "removed" };
        },
      });
      fixture.ask();
      await expect.poll(() => events).toEqual(["create"]);
      const cancellation = cancelProviderLaunch(
        harness.deps,
        fixture.thread.id,
      );
      await expect.poll(() => events).toEqual(["create", "abort"]);
      release();
      await cancellation;
      expect(events).toEqual(["create", "abort", "create-stopped", "remove"]);
    }));

  it("cleans each transient attempt before retrying under a new path key", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const creates: string[] = [];
      const removes: string[] = [];
      const fixture = setup(harness, {
        policy: {
          pathKeys: "per-attempt",
          transientRetryMs: 1,
          transientRetryLimit: 1,
        },
        create: async (context) => {
          creates.push(context.pathKey);
          return {
            status: "failed",
            failure: "transient",
            message: "offline",
          };
        },
        remove: async (context) => {
          removes.push(context.pathKey);
          return { status: "removed" };
        },
      });
      fixture.ask();
      await fixture.settled();
      expect(fixture.ask()).toMatchObject({
        action: "wait",
        reason: "offline; cleaning up before retry",
      });
      await expect.poll(() => removes).toEqual([`${fixture.thread.id}-1`]);
      await expect
        .poll(() => fixture.row())
        .toMatchObject({
          phase: "cancelled",
          cancelPending: false,
        });
      vi.setSystemTime(Date.now() + 2);
      fixture.ask();
      await fixture.settled();
      expect(fixture.ask()).toMatchObject({
        action: "reject",
        message: "offline",
      });
      await expect
        .poll(() => removes)
        .toEqual([`${fixture.thread.id}-1`, `${fixture.thread.id}-2`]);
      expect(creates).toEqual([
        `${fixture.thread.id}-1`,
        `${fixture.thread.id}-2`,
      ]);
      expect(fixture.row()).toMatchObject({
        attempt: 2,
        transientFailures: 2,
        phase: "cancelled",
        cancelPending: false,
      });
    }));

  it("round-trips a private resource handle into remove", async () =>
    withTestHarness(async (harness) => {
      const resources: JsonValue[] = [];
      const fixture = setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/resource-test",
          ownsPath: true,
          resource: { secret: "private" },
        }),
        remove: async (context) => {
          resources.push(context.resource);
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      expect(
        JSON.stringify(
          toEnvironmentResponse(getEnvironment(harness.db, environmentId)!),
        ),
      ).not.toContain("private");
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(resources).toEqual([{ secret: "private" }]);
      expect(getEnvironment(harness.db, environmentId)?.resource).toBeNull();
    }));

  it("rejects a resource handle larger than 16 KiB", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/cap",
          ownsPath: true,
          resource: "x".repeat(16_385),
        }),
      });
      fixture.ask();
      await fixture.settled();
      expect(fixture.ask()).toMatchObject({
        action: "reject",
        message: expect.stringContaining("16 KiB"),
      });
    }));

  it("serializes overlapping remove sweeps", async () =>
    withTestHarness(async (harness) => {
      let removes = 0;
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = setup(harness, {
        policy: { retireGraceMs: 0 },
        remove: async () => {
          removes += 1;
          await waiting;
          return { status: "removed" };
        },
      });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      const first = sweepProviderEnvironment(harness.deps, environmentId);
      await expect.poll(() => removes).toBe(1);
      const second = sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(removes).toBe(1);
    }));

  it("reserves a path until provider removal finishes", async () =>
    withTestHarness(async (harness) => {
      let removes = 0;
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const path = "/tmp/reserved-until-removed";
      const fixture = setup(harness, {
        policy: { retireGraceMs: 0 },
        create: async () => ({
          status: "created",
          path,
          ownsPath: true,
        }),
        remove: async () => {
          removes += 1;
          await waiting;
          return { status: "removed" };
        },
      });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      const removal = sweepProviderEnvironment(harness.deps, environmentId);
      await expect.poll(() => removes).toBe(1);
      await expect(
        resolveProducedEnvironmentPlacement(harness.deps, {
          environmentProviderId: fixture.record.provider.id,
          inputs: null,
          producedEnvironment: {
            type: "host",
            hostId: fixture.host.id,
            path,
            ownsPath: true,
          },
          projectId: fixture.context.project.id,
        }),
      ).rejects.toThrow(/not ready|unavailable/iu);
      release();
      await removal;
      await expect(
        resolveProducedEnvironmentPlacement(harness.deps, {
          environmentProviderId: fixture.record.provider.id,
          inputs: null,
          producedEnvironment: {
            type: "host",
            hostId: fixture.host.id,
            path,
            ownsPath: true,
          },
          projectId: fixture.context.project.id,
        }),
      ).resolves.toMatchObject({
        environmentId: null,
        environmentIntent: { type: "provider" },
      });
    }));

  it("records a failed remove and retries after the declared delay", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      let removes = 0;
      const fixture = setup(harness, {
        policy: { retireGraceMs: 0, removeRetryMs: 10 },
        remove: async () => {
          removes += 1;
          return removes === 1
            ? { status: "failed", message: "busy" }
            : { status: "removed" };
        },
      });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(getEnvironment(harness.db, environmentId)).toMatchObject({
        teardownStatus: "failed",
        teardownMessage: "busy",
      });
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(1);
      vi.setSystemTime(Date.now() + 11);
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(getEnvironment(harness.db, environmentId)).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("does not retire an environment under the keep policy", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness, { policy: { retireGraceMs: null } });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(getEnvironment(harness.db, environmentId)).toMatchObject({
        retireAt: null,
        teardownStatus: null,
        status: "ready",
      });
    }));

  it("cancels retirement when a live thread returns", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness, { policy: { retireGraceMs: 60_000 } });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(
        getEnvironment(harness.db, environmentId)?.retireAt,
      ).not.toBeNull();
      updateThread(harness.db, harness.hub, fixture.thread.id, {
        environmentId,
      });
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(getEnvironment(harness.db, environmentId)?.retireAt).toBeNull();
    }));

  it("waits for an archived runtime to stop before remove", async () =>
    withTestHarness(async (harness) => {
      let removes = 0;
      const fixture = setup(harness, {
        policy: { retireGraceMs: 0 },
        remove: async () => {
          removes += 1;
          return { status: "removed" };
        },
      });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      harness.db
        .update(threads)
        .set({
          environmentId,
          archivedAt: Date.now(),
          status: "stopping",
        })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(0);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(1);
    }));

  it("removes an expired environment through the periodic sweep", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness, { policy: { retireGraceMs: 0 } });
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      await runPeriodicSweeps({
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      });
      expect(getEnvironment(harness.db, environmentId)).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
        teardownAttempt: 1,
      });
    }));

  it("keeps destroyed rows until provider remove finishes", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness);
      fixture.ask();
      await fixture.settled();
      const environmentId = fixture.attach();
      harness.db
        .update(environments)
        .set({ status: "destroyed", updatedAt: 1, teardownStatus: "failed" })
        .where(eq(environments.id, environmentId))
        .run();
      const prune = () =>
        pruneDestroyedEnvironments(harness.db, harness.hub, {
          updatedBefore: Date.now(),
          eventBatchSize: 10,
          limit: 10,
        });
      expect(prune().deleted).toBe(0);
      harness.db
        .update(environments)
        .set({ teardownStatus: "removed" })
        .where(eq(environments.id, environmentId))
        .run();
      expect(prune().deleted).toBe(1);
    }));

  it.each([
    { retireGraceMs: 0, ownsPath: true },
    { retireGraceMs: null, ownsPath: true },
    { retireGraceMs: null, ownsPath: false },
  ])(
    "allows provider source cleanup during project deletion with grace $retireGraceMs and ownsPath $ownsPath",
    async ({ retireGraceMs, ownsPath }) =>
      withTestHarness(async (harness) => {
        let cleanupStatus = 0;
        const fixture = setup(harness, {
          policy: { retireGraceMs },
          create: async () => ({
            status: "created",
            path: "/tmp/project-cleanup",
            ownsPath,
          }),
          remove: async (context) => {
            const projectId = context.environment?.projectId;
            if (projectId === undefined) throw new Error("Missing project");
            const response = await harness.app.request(
              `/api/v1/projects/${projectId}/sources/${fixture.source.id}`,
              { method: "DELETE" },
            );
            cleanupStatus = response.status;
            return response.ok
              ? { status: "removed" }
              : { status: "failed", message: await response.text() };
          },
        });
        fixture.ask();
        await fixture.settled();
        const environmentId = fixture.attach();
        harness.db
          .update(threads)
          .set({ status: "idle" })
          .where(eq(threads.id, fixture.thread.id))
          .run();
        beginProjectDeletion(harness.deps, {
          projectId: fixture.context.project.id,
        });
        await advanceProjectDeletion(harness.deps, {
          projectId: fixture.context.project.id,
        });
        expect(
          cleanupStatus,
          JSON.stringify(getEnvironment(harness.db, environmentId)),
        ).toBe(200);
        expect(getEnvironment(harness.db, environmentId)).toBeNull();
        expect(getProject(harness.db, fixture.context.project.id)).toBeNull();
      }),
  );
});
