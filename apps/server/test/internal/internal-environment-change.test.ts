import { getEnvironment } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

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

  it("accepts thread storage change hints for session-owned environments", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-thread-storage-change",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/env-thread-storage-change",
        status: "ready",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");

      const response = await harness.app.request("/internal/session/environment-change", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          environmentId: environment.id,
          change: "thread-storage-changed",
        }),
      });

      expect(response.status).toBe(200);
      expect(notifyEnvironmentSpy).toHaveBeenCalledWith(environment.id, [
        "thread-storage-changed",
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts shared git ref change hints for session-owned environments", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-git-refs-change",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/env-git-refs-change",
        status: "ready",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");

      const response = await harness.app.request("/internal/session/environment-change", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          environmentId: environment.id,
          change: "git-refs-changed",
        }),
      });

      expect(response.status).toBe(200);
      expect(notifyEnvironmentSpy).toHaveBeenCalledWith(environment.id, [
        "git-refs-changed",
      ]);
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

  it("returns 404 for unknown environments", async () => {
    const harness = await createTestAppHarness();
    try {
      const { session } = seedHostSession(harness.deps, {
        id: "host-env-change-missing",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");

      const response = await harness.app.request("/internal/session/environment-change", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          environmentId: "env-missing",
          change: "work-status-changed",
        }),
      });

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "environment_not_found",
      });
      expect(notifyEnvironmentSpy).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 400 for invalid environment change kinds", async () => {
    const harness = await createTestAppHarness();
    try {
      const { session } = seedHostSession(harness.deps, {
        id: "host-env-change-invalid",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");

      const response = await harness.app.request("/internal/session/environment-change", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          environmentId: "env-1",
          change: "status-changed",
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(notifyEnvironmentSpy).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});
