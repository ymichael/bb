import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public project source remote refresh", () => {
  it("backfills a missing remote when a local source is updated", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-source-remote-refresh",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source-remote-refresh",
      });
      expect(project.gitRemoteUrl).toBeNull();

      const updatePromise = harness.app.request(
        `/api/v1/projects/${project.id}/sources/${source.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "local_path",
            path: source.path,
          }),
        },
      );
      const inspection = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "project.inspect" && command.path === source.path,
      );
      await reportQueuedCommandSuccess(harness, inspection, {
        path: source.path,
        gitRemoteUrl: "ssh://git.example.test/team/project.git",
      });

      const updateResponse = await updatePromise;
      expect(updateResponse.status).toBe(200);
      const projectResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
      );
      await expect(readJson(projectResponse)).resolves.toMatchObject({
        gitRemoteUrl: "ssh://git.example.test/team/project.git",
      });
    });
  });
});
