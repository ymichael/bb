import { mkdir, rm, stat } from "node:fs/promises";
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import { personalWorkspaceHostContract } from "./contract.js";
import {
  assertRemovableWorkspacePath,
  resolveWorkspacePath,
} from "./host/paths.js";

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export function createPersonalWorkspaceHostEntry() {
  return experimental_defineHostEntry({
    contract: personalWorkspaceHostContract,
    handlers: {
      async createWorkspace(input, context) {
        const target = resolveWorkspacePath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
        });
        await mkdir(target, { recursive: true });
        return { path: target };
      },

      async removeWorkspace(input, context) {
        const target =
          input.path === null
            ? resolveWorkspacePath({
                dataDir: context.experimental_paths.dataDir,
                pathKey: input.pathKey,
              })
            : assertRemovableWorkspacePath({
                dataDir: context.experimental_paths.dataDir,
                path: input.path,
              });
        const existed = await pathExists(target);
        if (existed) {
          await experimental_killProcessesWithCwdUnder({ directory: target });
        }
        await rm(target, { recursive: true, force: true });
        return { removed: existed };
      },
    },
  });
}

export default createPersonalWorkspaceHostEntry();
