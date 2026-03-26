import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveThreadRuntimeConfig } from "../src/services/thread-runtime-config.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedThread } from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("thread runtime config", () => {
  it("renders manager instructions and dynamic tools from workspace preferences", async () => {
    const harness = await createTestAppHarness();
    const managerWorkspacePath = await mkdtemp(
      path.join(tmpdir(), "bb-manager-runtime-config-"),
    );
    try {
      await writeFile(
        path.join(managerWorkspacePath, "PREFERENCES.md"),
        "Prefer concise user updates.\nDelegate implementation quickly.\n",
        "utf8",
      );

      const { host } = seedHostSession(harness.deps, { id: "host-manager-runtime" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Manager Runtime Project",
        path: "/tmp/manager-project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: managerWorkspacePath,
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        title: "Project manager",
      });

      const config = await resolveThreadRuntimeConfig(harness.deps, {
        environment,
        thread: managerThread,
      });

      expect(config.dynamicTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "message_user" }),
          expect.objectContaining({ name: "spawn_thread" }),
        ]),
      );
      expect(config.instructions).toContain("You are a manager for this project.");
      expect(config.instructions).toContain("Prefer concise user updates.");
      expect(config.instructions).toContain("Delegate implementation quickly.");
      expect(config.instructions).toContain(managerThread.id);
      expect(config.instructions).toContain(project.name);
      expect(config.instructions).toContain("/tmp/manager-project-root");
      expect(config.instructions).toContain(managerWorkspacePath);
    } finally {
      await rm(managerWorkspacePath, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});
