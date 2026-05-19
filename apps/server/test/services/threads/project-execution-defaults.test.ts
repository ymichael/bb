import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { createThreadFromRequest } from "../../../src/services/threads/thread-create.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../../helpers/seed.js";
import { createTestAppHarness } from "../../helpers/test-app.js";

describe("project execution defaults persistence", () => {
  it("does not overwrite project defaults when an app thread reuses an existing environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reuse-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-defaults-environment",
      });

      // Seed a known default — anything that mutates this table during
      // submission would be visible by comparing to this baseline.
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "standard",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });

      await createThreadFromRequest(harness.deps, {
        // origin: "app" + automationId: null is the path that normally
        // remembers defaults. The reuse env type must override that.
        origin: "app",
        automationId: null,
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
        type: "standard",
        managerTemplateName: null,
        input: [{ type: "text", text: "Reuse one-off" }],
        environment: { type: "reuse", environmentId: environment.id },
      });

      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          threadType: "standard",
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does overwrite project defaults for a regular app thread (non-reuse env)", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-non-reuse-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "standard",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });

      await createThreadFromRequest(harness.deps, {
        origin: "app",
        automationId: null,
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
        type: "standard",
        managerTemplateName: null,
        input: [{ type: "text", text: "Set new defaults" }],
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: null },
        },
      });

      // Sanity: host-mode submissions still update project defaults — proves
      // the reuse-only carve-out above isn't accidentally turning the whole
      // persistence path off.
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          threadType: "standard",
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
