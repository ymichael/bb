import { getEnvironment } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("internal environment change route", () => {
  it("notifies clients for valid session-owned environment change hints without mutating the environment row", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-change",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/env-change",
        status: "ready",
      });
      const before = getEnvironment(harness.db, environment.id);
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");

      const response = await harness.app.request("/internal/session/environment-change", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          environmentId: environment.id,
          change: "work-status-changed",
        }),
      });

      expect(response.status).toBe(200);
      expect(notifyEnvironmentSpy).toHaveBeenCalledWith(environment.id, [
        "work-status-changed",
      ]);
      expect(getEnvironment(harness.db, environment.id)).toEqual(before);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects environment change hints for environments owned by a different host", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostA = seedHostSession(harness.deps, { id: "host-env-change-a" });
      const hostB = seedHostSession(harness.deps, { id: "host-env-change-b" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: hostB.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: hostB.host.id,
        projectId: project.id,
        path: "/tmp/env-change-other-host",
        status: "ready",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");

      const response = await harness.app.request("/internal/session/environment-change", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: hostA.session.id,
          environmentId: environment.id,
          change: "work-status-changed",
        }),
      });

      expect(response.status).toBe(403);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(notifyEnvironmentSpy).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});
