import fs from "node:fs/promises";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { withHarness } from "../../helpers/harness.js";
import { createReadyThread } from "./shared.js";

describe.sequential("personal workspace plugin integration", () => {
  it("gives every root personal thread its own workspace directory", () =>
    withHarness(
      { builtinPlugins: ["environment-personal-workspace"] },
      async (harness) => {
        const first = await createReadyThread(harness, {
          projectId: PERSONAL_PROJECT_ID,
          workspace: { type: "personal" },
        });

        expect(first.environment.environmentProviderId).toBe(
          "personal-workspace",
        );
        expect(first.environment.environmentProviderSelection).toEqual({
          machine: { type: "existing", hostId: harness.hostId },
          inputs: null,
        });
        const workspacePath = first.environment.path;
        if (workspacePath === null) {
          throw new Error("Personal workspace path was not assigned");
        }
        expect(workspacePath).toContain(
          `plugins/environment-personal-workspace/host-data/workspaces/${first.thread.id}`,
        );
        await fs.access(workspacePath);

        const second = await createReadyThread(harness, {
          projectId: PERSONAL_PROJECT_ID,
          workspace: { type: "personal" },
        });

        expect(second.environment.id).not.toBe(first.environment.id);
        expect(second.thread.environmentId).toBe(second.environment.id);
        expect(second.environment.path).toContain(
          `plugins/environment-personal-workspace/host-data/workspaces/${second.thread.id}`,
        );
        expect(second.environment.path).not.toBe(workspacePath);
      },
    ));
});
