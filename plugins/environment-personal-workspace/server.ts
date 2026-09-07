import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { personalWorkspaceHostContract } from "./contract.js";
import { PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

export default async function personalWorkspacePlugin(
  bb: BbPluginApi,
): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: personalWorkspaceHostContract,
  });

  bb.experimental_environments.register({
    id: PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Personal workspace",
    icon: "Folder",
    requires: { projectless: true },
    async create({ host: machine, pathKey, rebuild, report, signal }) {
      report.step(`${rebuild ? "Restoring" : "Preparing"} personal workspace…`);
      try {
        const created = await host.call(
          "createWorkspace",
          { pathKey },
          { hostId: machine.id, signal },
        );
        return {
          status: "created",
          ownsPath: true,
          path: created.path,
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          status: "failed",
          failure: "transient",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async remove({ hostId, path, pathKey, signal }) {
      if (hostId === null) {
        return {
          status: "failed",
          message: "The personal workspace machine is unknown",
        };
      }
      try {
        await host.call(
          "removeWorkspace",
          { pathKey, path },
          { hostId, signal },
        );
        return { status: "removed" };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
