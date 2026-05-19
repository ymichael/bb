import { constants as fsConstants, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  managerTemplateNameSchema,
  type ManagerTemplateName,
} from "@bb/domain";
import type { LoggedWorkSessionDeps, ServerLogger } from "../../types.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";

export const MANAGER_TEMPLATE_DIR_NAME = "manager-templates";
export const ACTIVE_MANAGER_TEMPLATE_FILE_NAME = "active";
export const DEFAULT_MANAGER_TEMPLATE_NAME: ManagerTemplateName = "default";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultTemplateAssetDir = path.join(moduleDir, "default-template");

function loadDefaultTemplateAsset(fileName: string): string {
  return readFileSync(path.join(defaultTemplateAssetDir, fileName), "utf8");
}

type ManagerTemplateLogger = Pick<ServerLogger, "debug" | "warn">;

interface BuiltInManagerTemplateFile {
  content: string;
  fileName: string;
}

interface BuiltInManagerTemplateSet {
  files: readonly BuiltInManagerTemplateFile[];
  name: ManagerTemplateName;
}

interface EnsureBuiltInManagerTemplatesInstalledArgs {
  dataDir: string;
  logger: ManagerTemplateLogger;
}

interface ResolveManagerTemplateNameArgs {
  dataDir: string;
  explicitTemplateName: ManagerTemplateName | null;
  logger: ManagerTemplateLogger;
}

interface SeedManagerThreadStorageArgs {
  explicitTemplateName: ManagerTemplateName | null;
  hostId: string;
  threadId: string;
  threadStoragePath: string;
}

interface CopyTemplateFilesArgs {
  logger: ManagerTemplateLogger;
  templateDirPath: string;
  templateName: ManagerTemplateName;
  threadId: string;
  threadStoragePath: string;
}

interface FsErrorWithCodeArgs {
  code: string;
  error: unknown;
}

interface ManagerTemplateRootPathArgs {
  dataDir: string;
}

interface ManagerTemplateSetPathArgs extends ManagerTemplateRootPathArgs {
  templateName: ManagerTemplateName;
}

interface PathExistsArgs {
  filePath: string;
}

interface WriteFileIfAbsentArgs {
  content: string;
  filePath: string;
}

const BUILT_IN_MANAGER_TEMPLATE_SETS: readonly BuiltInManagerTemplateSet[] = [
  {
    name: DEFAULT_MANAGER_TEMPLATE_NAME,
    files: [
      {
        fileName: "STATUS.html",
        content: loadDefaultTemplateAsset("STATUS.html"),
      },
    ],
  },
];

function isFsErrorWithCode(args: FsErrorWithCodeArgs): boolean {
  return (
    typeof args.error === "object" &&
    args.error !== null &&
    "code" in args.error &&
    args.error.code === args.code
  );
}

export function managerTemplateRootPath(
  args: ManagerTemplateRootPathArgs,
): string {
  return path.join(args.dataDir, MANAGER_TEMPLATE_DIR_NAME);
}

function managerTemplateSetPath(args: ManagerTemplateSetPathArgs): string {
  return path.join(
    managerTemplateRootPath({ dataDir: args.dataDir }),
    args.templateName,
  );
}

function activeManagerTemplatePath(args: ManagerTemplateRootPathArgs): string {
  return path.join(
    managerTemplateRootPath({ dataDir: args.dataDir }),
    ACTIVE_MANAGER_TEMPLATE_FILE_NAME,
  );
}

async function pathExists(args: PathExistsArgs): Promise<boolean> {
  try {
    await stat(args.filePath);
    return true;
  } catch (error) {
    if (isFsErrorWithCode({ error, code: "ENOENT" })) {
      return false;
    }
    throw error;
  }
}

async function writeFileIfAbsent(args: WriteFileIfAbsentArgs): Promise<void> {
  try {
    await writeFile(args.filePath, args.content, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isFsErrorWithCode({ error, code: "EEXIST" })) {
      throw error;
    }
  }
}

export async function ensureBuiltInManagerTemplatesInstalled(
  args: EnsureBuiltInManagerTemplatesInstalledArgs,
): Promise<void> {
  const templateRootPath = managerTemplateRootPath({ dataDir: args.dataDir });
  await mkdir(templateRootPath, { recursive: true });
  await writeFileIfAbsent({
    filePath: activeManagerTemplatePath({ dataDir: args.dataDir }),
    content: `${DEFAULT_MANAGER_TEMPLATE_NAME}\n`,
  });

  for (const templateSet of BUILT_IN_MANAGER_TEMPLATE_SETS) {
    const templateSetPath = managerTemplateSetPath({
      dataDir: args.dataDir,
      templateName: templateSet.name,
    });
    if (await pathExists({ filePath: templateSetPath })) {
      continue;
    }
    await mkdir(templateSetPath, { recursive: true });
    for (const file of templateSet.files) {
      await writeFile(
        path.join(templateSetPath, file.fileName),
        file.content,
        "utf8",
      );
    }
    args.logger.debug(
      { templateName: templateSet.name, templateSetPath },
      "Installed built-in manager template set",
    );
  }
}

async function readActiveManagerTemplateName(
  args: ResolveManagerTemplateNameArgs,
): Promise<ManagerTemplateName> {
  if (args.explicitTemplateName !== null) {
    return args.explicitTemplateName;
  }

  let activeContent: string;
  try {
    activeContent = await readFile(
      activeManagerTemplatePath({ dataDir: args.dataDir }),
      "utf8",
    );
  } catch (error) {
    if (isFsErrorWithCode({ error, code: "ENOENT" })) {
      return DEFAULT_MANAGER_TEMPLATE_NAME;
    }
    throw error;
  }

  const activeLine = activeContent.split(/\r?\n/u)[0]?.trim() ?? "";
  if (activeLine.length === 0) {
    return DEFAULT_MANAGER_TEMPLATE_NAME;
  }

  const parsed = managerTemplateNameSchema.safeParse(activeLine);
  if (parsed.success) {
    return parsed.data;
  }

  args.logger.warn(
    {
      activeLine,
      activePath: activeManagerTemplatePath({ dataDir: args.dataDir }),
    },
    "Ignoring invalid active manager template pointer",
  );
  return DEFAULT_MANAGER_TEMPLATE_NAME;
}

async function copyTemplateFiles(args: CopyTemplateFilesArgs): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(args.templateDirPath, { withFileTypes: true });
  } catch (error) {
    if (isFsErrorWithCode({ error, code: "ENOENT" })) {
      args.logger.warn(
        {
          templateName: args.templateName,
          templateDirPath: args.templateDirPath,
          threadId: args.threadId,
        },
        "Manager template directory is missing; skipping storage seed",
      );
      return;
    }
    throw error;
  }

  await mkdir(args.threadStoragePath, { recursive: true });

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const sourcePath = path.join(args.templateDirPath, entry.name);
    const destinationPath = path.join(args.threadStoragePath, entry.name);
    try {
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (isFsErrorWithCode({ error, code: "EEXIST" })) {
        continue;
      }
      if (isFsErrorWithCode({ error, code: "ENOENT" })) {
        args.logger.warn(
          {
            sourcePath,
            templateName: args.templateName,
            threadId: args.threadId,
          },
          "Manager template file disappeared while seeding storage",
        );
        continue;
      }
      throw error;
    }
  }
}

export async function seedManagerThreadStorage(
  deps: LoggedWorkSessionDeps,
  args: SeedManagerThreadStorageArgs,
): Promise<void> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.hostId,
  });
  const templateName = await readActiveManagerTemplateName({
    dataDir: session.dataDir,
    explicitTemplateName: args.explicitTemplateName,
    logger: deps.logger,
  });
  await copyTemplateFiles({
    logger: deps.logger,
    templateDirPath: managerTemplateSetPath({
      dataDir: session.dataDir,
      templateName,
    }),
    templateName,
    threadId: args.threadId,
    threadStoragePath: args.threadStoragePath,
  });
}
