import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  createProjectSource,
  environments,
  events,
  getThread,
  getThreadOperation,
  hostDaemonCommands,
  listThreads,
  transitionThreadStatus,
} from "@bb/db";
import { threadSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { completeThreadStart } from "../../src/services/threads/thread-lifecycle.js";
import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface WaitForThreadStatusArgs {
  status: string;
  threadId: string;
  timeoutMs?: number;
}

async function waitForThreadStatus(
  harness: TestAppHarness,
  args: WaitForThreadStatusArgs,
): Promise<void> {
  const deadline = Date.now() + (args.timeoutMs ?? 1_000);
  while (Date.now() < deadline) {
    if (getThread(harness.db, args.threadId)?.status === args.status) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for thread ${args.threadId} to be ${args.status}`);
}

describe("public thread lifecycle regressions", () => {
  it("uses unique branch names for same-title managed worktree threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-branch-unique" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/branch-unique",
      });

      const firstResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Worker Thread",
          input: [{ type: "text", text: "Implement the worker task" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree" },
          },
        }),
      });
      expect(firstResponse.status).toBe(201);
      const firstThread = await readJson(firstResponse);
      const firstProvision = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision",
      );

      const secondResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Worker Thread",
          input: [{ type: "text", text: "Implement the worker task again" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree" },
          },
        }),
      });
      expect(secondResponse.status).toBe(201);
      const secondThread = await readJson(secondResponse);
      const secondProvision = await waitForQueuedCommandAfter(
        harness,
        firstProvision.row.cursor,
        ({ command }) =>
          command.type === "environment.provision",
      );

      expect(firstThread).toMatchObject({ id: expect.any(String) });
      expect(secondThread).toMatchObject({ id: expect.any(String) });
      if (
        typeof firstThread !== "object" ||
        !firstThread ||
        !("id" in firstThread) ||
        typeof firstThread.id !== "string" ||
        typeof secondThread !== "object" ||
        !secondThread ||
        !("id" in secondThread) ||
        typeof secondThread.id !== "string"
      ) {
        throw new Error("Thread creation response shape was invalid");
      }

      expect(firstProvision.command.branchName).toBe(`bb/${firstThread.id}`);
      expect(secondProvision.command.branchName).toBe(`bb/${secondThread.id}`);
      expect(firstProvision.command.branchName).not.toBe(secondProvision.command.branchName);
    } finally {
      await harness.cleanup();
    }
  });

  it("promotes a non-default-host environment using that host's source path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-promote-default",
      });
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-promote-secondary",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/promote-default-source",
      });
      const secondarySource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/promote-secondary-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: secondaryHost.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/promote-secondary-source/.bb-worktrees/thread",
        branchName: "bb/promote-secondary",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "promote" }),
        },
      );

      const promoteCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.promote" &&
          command.environmentId === environment.id,
      );
      expect(promoteCommand.command).toMatchObject({
        primaryPath: secondarySource.path,
      });
      await reportQueuedCommandSuccess(
        harness,
        promoteCommand,
        { ok: true },
        { hostId: secondaryHost.id },
      );

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "promote",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("demotes a non-default-host environment using that host's source path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-demote-default",
      });
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-demote-secondary",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/demote-default-source",
      });
      const secondarySource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/demote-secondary-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: secondaryHost.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/demote-secondary-source/.bb-worktrees/thread",
        branchName: "bb/demote-secondary",
        mergeBaseBranch: "main",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "demote" }),
        },
      );

      const demoteCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.demote" &&
          command.environmentId === environment.id,
      );
      expect(demoteCommand.command).toMatchObject({
        primaryPath: secondarySource.path,
        defaultBranch: "main",
        envBranch: "bb/demote-secondary",
      });
      await reportQueuedCommandSuccess(
        harness,
        demoteCommand,
        { ok: true },
        { hostId: secondaryHost.id },
      );

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "demote",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("leaves reused thread creation provisioning when the host is disconnected", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-reuse-disconnected" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reuse-disconnected",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-disconnected",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Start immediately" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        environmentId: environment.id,
        status: "provisioning",
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(1);

      const queuedCommand = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .get();
      expect(queuedCommand).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("fails direct-host provisioning durably when the host is disconnected", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-direct-disconnected" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/direct-disconnected",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Disconnected host thread",
          input: [{ type: "text", text: "Start on disconnected host" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: "/tmp/direct-disconnected" },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      await advanceThreadProvisioning(harness.deps, {
        threadId: createdThread.id,
      });
      await waitForThreadStatus(harness, {
        threadId: createdThread.id,
        status: "error",
      });

      expect(getThreadOperation(harness.db, {
        threadId: createdThread.id,
        kind: "provision",
      })?.state).toBe("failed");
      const errorEvent = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all()
        .find((event) => event.type === "system/error");
      expect(errorEvent ? JSON.parse(errorEvent.data) : null).toMatchObject({
        code: "thread_provisioning_failed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("dedupes concurrent direct-host provisioning advances", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-direct-dedupe",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/direct-dedupe",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Concurrent provisioning",
          input: [{ type: "text", text: "Create only one workspace" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree" },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      await Promise.all([
        advanceThreadProvisioning(harness.deps, { threadId: createdThread.id }),
        advanceThreadProvisioning(harness.deps, { threadId: createdThread.id }),
      ]);

      const provisionCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.provision"))
        .all();
      const createdEnvironments = harness.db
        .select()
        .from(environments)
        .where(eq(environments.projectId, project.id))
        .all();
      expect(provisionCommands).toHaveLength(1);
      expect(createdEnvironments).toHaveLength(1);
      expect(getThread(harness.db, createdThread.id)?.environmentId).toBe(
        createdEnvironments[0]?.id,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("only queues environment.destroy after the last thread in a managed environment is deleted", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-thread-cleanup" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/thread-cleanup",
      });
      const firstThread = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "First reused thread" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });
      const secondThread = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Second reused thread" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(firstThread.status).toBe(201);
      expect(secondThread.status).toBe(201);
      const firstThreadBody = threadSchema.parse(await readJson(firstThread));
      const secondThreadBody = threadSchema.parse(await readJson(secondThread));

      const firstStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === firstThreadBody.id,
      );
      const secondStart = await waitForQueuedCommandAfter(
        harness,
        firstStart.row.cursor,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === secondThreadBody.id,
      );
      expect(secondStart.command).toMatchObject({
        threadId: secondThreadBody.id,
      });
      completeThreadStart(harness.deps, {
        threadId: firstThreadBody.id,
      });
      transitionThreadStatus(harness.db, harness.deps.hub, firstThreadBody.id, "idle");
      completeThreadStart(harness.deps, {
        threadId: secondThreadBody.id,
      });
      transitionThreadStatus(harness.db, harness.deps.hub, secondThreadBody.id, "idle");

      const firstDelete = await harness.app.request(
        `/api/v1/threads/${firstThreadBody.id}`,
        { method: "DELETE" },
      );
      expect(firstDelete.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "environment.destroy"))
          .all(),
      ).toHaveLength(0);

      const secondDelete = await harness.app.request(
        `/api/v1/threads/${secondThreadBody.id}`,
        { method: "DELETE" },
      );
      expect(secondDelete.status).toBe(200);

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails reused threads when a provisioning environment has no active lifecycle operation", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-reuse-provisioning" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reuse-provisioning",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-provisioning",
        status: "provisioning",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Wait for provisioning" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));

      await advanceThreadProvisioning(harness.deps, {
        threadId: createdThread.id,
      });
      await waitForThreadStatus(harness, {
        threadId: createdThread.id,
        status: "error",
      });
      expect(getThreadOperation(harness.db, {
        threadId: createdThread.id,
        kind: "provision",
      })?.state).toBe("failed");
      const errorEvent = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all()
        .find((event) => event.type === "system/error");
      expect(errorEvent ? JSON.parse(errorEvent.data) : null).toMatchObject({
        code: "thread_provisioning_failed",
        detail: "Environment is provisioning without an active provision operation",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
