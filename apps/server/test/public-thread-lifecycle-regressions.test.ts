import { eq } from "drizzle-orm";
import { hostDaemonCommands, listThreads } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
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
          title: "Worker Thread",
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
          command.type === "environment.provision" &&
          command.projectId === project.id,
      );

      const secondResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          title: "Worker Thread",
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
          command.type === "environment.provision" &&
          command.projectId === project.id,
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

      expect(firstProvision.command.branchName).toContain(firstThread.id.slice(0, 8));
      expect(secondProvision.command.branchName).toContain(secondThread.id.slice(0, 8));
      expect(firstProvision.command.branchName).not.toBe(secondProvision.command.branchName);
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes a reused thread if queueing the initial start fails", async () => {
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
          input: [{ type: "text", text: "Start immediately" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(502);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_disconnected",
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);
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
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(firstThread.status).toBe(201);
      expect(secondThread.status).toBe(201);
      const firstThreadBody = await readJson(firstThread);
      const secondThreadBody = await readJson(secondThread);
      if (
        typeof firstThreadBody !== "object" ||
        !firstThreadBody ||
        !("id" in firstThreadBody) ||
        typeof firstThreadBody.id !== "string" ||
        typeof secondThreadBody !== "object" ||
        !secondThreadBody ||
        !("id" in secondThreadBody) ||
        typeof secondThreadBody.id !== "string"
      ) {
        throw new Error("Thread creation response shape was invalid");
      }

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
        path: "/tmp/thread-cleanup",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
