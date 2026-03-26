import { describe, expect, it } from "vitest";
import { hostDaemonCommands } from "@bb/db";
import { createTestAppHarness } from "./helpers/test-app.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "./helpers/seed.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("public API routes", () => {
  it("serves public routes without auth and rejects internal routes without a bearer token", async () => {
    const harness = await createTestAppHarness();
    try {
      const publicResponse = await harness.app.request("/api/v1/system/config");
      expect(publicResponse.status).toBe(200);

      const internalResponse = await harness.app.request("/internal/session/commands");
      expect(internalResponse.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a host-backed unmanaged thread and queues environment.provision", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-1" });
      seedSession(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-root",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          input: [{ type: "text", text: "Build the feature" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: null },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = await readJson(response) as { environmentId: string | null; status: string };
      expect(thread.status).toBe("provisioning");
      expect(thread.environmentId).toBeTruthy();

      const commands = harness.db.select().from(hostDaemonCommands).all();
      expect(commands).toHaveLength(1);
      expect(commands[0]?.type).toBe("environment.provision");
    } finally {
      await harness.cleanup();
    }
  });

  it("queues turn.run for an idle thread send", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-1" });
      seedSession(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Continue with tests" }],
        }),
      });

      expect(response.status).toBe(200);
      const commands = harness.db.select().from(hostDaemonCommands).all();
      expect(commands.at(-1)?.type).toBe("turn.run");
      const updatedThread = harness.db
        .select()
        .from((await import("@bb/db")).threads)
        .where((await import("drizzle-orm")).eq((await import("@bb/db")).threads.id, thread.id))
        .get();
      expect(updatedThread?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("queues thread.rename when a ready thread title changes", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-1" });
      seedSession(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Old title",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      });

      expect(response.status).toBe(200);
      const commands = harness.db.select().from(hostDaemonCommands).all();
      expect(commands.at(-1)?.type).toBe("thread.rename");
    } finally {
      await harness.cleanup();
    }
  });
});
