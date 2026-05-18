import path from "node:path";
import {
  managerStorageFileNameValues,
  managerTemplateFileNameByStorageFileName,
} from "@bb/domain";
import type { ThreadStorageSeedTemplate } from "@bb/host-daemon-contract";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";

export const MANAGER_TEMPLATE_DIR_NAME = "manager-templates";

interface BuildManagerStorageSeedTemplatesArgs {
  hostId: string;
}

export function managerTemplateRootPath(dataDir: string): string {
  return path.join(dataDir, MANAGER_TEMPLATE_DIR_NAME);
}

export async function buildManagerStorageSeedTemplates(
  deps: LoggedWorkSessionDeps,
  args: BuildManagerStorageSeedTemplatesArgs,
): Promise<ThreadStorageSeedTemplate[]> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.hostId,
  });
  const templateRootPath = managerTemplateRootPath(session.dataDir);
  return managerStorageFileNameValues.map((fileName) => {
    const templatePath = path.join(
      templateRootPath,
      managerTemplateFileNameByStorageFileName[fileName],
    );
    return {
      fileName,
      templatePath,
      templateRootPath,
    };
  });
}
