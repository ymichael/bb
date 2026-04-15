import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  createPendingInteraction,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  threads,
} from "@bb/db";
import { threadSchema } from "@bb/domain";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
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

describe("public thread environment routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });


  it("includes hasPendingInteraction in thread list responses", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-list-pending",
      });
      const firstThread = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "codex",
      });
      const secondThread = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "codex",
      });

      createPendingInteraction(harness.db, {
        payload: "{}",
        providerId: "codex",
        providerRequestId: "request-1",
        providerThreadId: "provider-thread-1",
        sessionId: "session-1",
        threadId: firstThread.id,
        turnId: "turn_1",
      });

      const response = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}&archived=false`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: secondThread.id,
            hasPendingInteraction: false,
          }),
          expect.objectContaining({
            id: firstThread.id,
            hasPendingInteraction: true,
          }),
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });


  it("includes environmentWorkspaceDisplayKind in thread list responses", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const sandboxHost = seedHost(harness.deps, {
        id: "host-thread-list-sandbox",
        type: "ephemeral",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-list-environment-kind",
      });
      const directEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-list-environment-kind/direct",
        projectId: project.id,
        workspaceProvisionType: "unmanaged",
      });
      const worktreeEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-list-environment-kind/worktree",
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });
      const sandboxEnvironment = seedEnvironment(harness.deps, {
        hostId: sandboxHost.id,
        path: "/tmp/thread-list-environment-kind/sandbox",
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });
      const directThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: directEnvironment.id,
      });
      const worktreeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: worktreeEnvironment.id,
      });
      const sandboxThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: sandboxEnvironment.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}&archived=false`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: directThread.id,
            environmentWorkspaceDisplayKind: "primary-checkout",
          }),
          expect.objectContaining({
            id: worktreeThread.id,
            environmentWorkspaceDisplayKind: "git-worktree",
          }),
          expect.objectContaining({
            id: sandboxThread.id,
            environmentWorkspaceDisplayKind: "sandbox",
          }),
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });


  it("reuses the ready unmanaged environment for the default source path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/shared-unmanaged-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: source.path,
        status: "ready",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Reuse the existing direct workspace" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread).toMatchObject({
        environmentId: environment.id,
        status: "provisioning",
      });

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.environmentId === environment.id &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        workspaceContext: { workspacePath: source.path, workspaceProvisionType: "unmanaged" },
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
      });
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        type: "standard",
        parentThreadId: null,
      });

      const provisionCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.provision"))
        .all();
      expect(provisionCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });


  it("attaches new threads to an in-flight unmanaged environment without reprovisioning", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/inflight-unmanaged-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: source.path,
        status: "provisioning",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Wait for the existing provisioning flow" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        environmentId: environment.id,
        status: "provisioning",
      });

      const queuedCommands = harness.db.select().from(hostDaemonCommands).all();
      expect(queuedCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });


  it("reuses an existing environment when requested", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Reuse the environment" }],
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
    } finally {
      await harness.cleanup();
    }
  });


  it("fails managed reprovision send when the host is disconnected", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-send-reprovision-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/send-reprovision-offline-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/send-reprovision-offline-target",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            model: "gpt-5",
            input: [{ type: "text", text: "Resume after reconnect" }],
          }),
        },
      );

      expect(response.status).toBe(502);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_disconnected",
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "environment.provision"))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});
