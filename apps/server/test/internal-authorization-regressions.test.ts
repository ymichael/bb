import { eq } from "drizzle-orm";
import {
  events,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  queueCommand,
  threads,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { appendClientTurnEvent } from "../src/services/thread-events.js";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("internal authorization regressions", () => {
  it("rejects cross-host command results before mutating command state or side effects", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostA = seedHostSession(harness.deps, { id: "host-auth-a" });
      const hostB = seedHostSession(harness.deps, { id: "host-auth-b" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: hostB.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: hostB.host.id,
        projectId: project.id,
        path: "/tmp/cross-host-command",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/thread/start",
        input: [{ type: "text", text: "Start after provisioning" }],
        execution: {
          model: "gpt-5",
          serviceTier: "flex",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/thread/start",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: hostB.host.id,
        sessionId: hostB.session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: environment.id,
          projectId: project.id,
          workspaceProvisionType: "unmanaged",
          path: "/tmp/cross-host-command",
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: hostA.session.id,
          commandId: command.id,
          cursor: command.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/cross-host-command",
            branchName: "bb/cross-host",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: false,
            ranSetup: false,
          },
        }),
      });

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "command_not_found",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, command.id))
          .get(),
      ).toMatchObject({
        id: command.id,
        state: "pending",
        resultPayload: null,
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("provisioning");
      expect(getThread(harness.db, thread.id)?.status).toBe("provisioning");
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects event batches for threads owned by a different host", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostA = seedHostSession(harness.deps, { id: "host-events-a" });
      const hostB = seedHostSession(harness.deps, { id: "host-events-b" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: hostB.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: hostB.host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: hostA.session.id,
          events: [
            {
              id: "evt-cross-host",
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-cross-host",
                turnId: "turn-cross-host",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(403);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects reusing an environment from a different project", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-reuse-check" });
      const { project: projectA } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-a",
      });
      const { project: projectB } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-b",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: projectB.id,
        path: "/tmp/project-b-env",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: projectA.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Reuse the other project environment" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.projectId, projectA.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});
