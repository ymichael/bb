import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";

const execFileAsync = promisify(execFile);

export type WorkspaceOpenTargetErrorCode =
  | "path_not_directory"
  | "target_unavailable"
  | "unsupported_platform";

export interface WorkspaceOpenTargetErrorOptions {
  code: WorkspaceOpenTargetErrorCode;
  message: string;
}

export class WorkspaceOpenTargetError extends Error {
  readonly code: WorkspaceOpenTargetErrorCode;

  constructor(options: WorkspaceOpenTargetErrorOptions) {
    super(options.message);
    this.name = "WorkspaceOpenTargetError";
    this.code = options.code;
  }
}

export interface WorkspaceOpenTargetLauncherArgs {
  path: string;
  targetId: WorkspaceOpenTargetId;
}

interface ExecFileResult {
  stdout: string;
}

type ExecFileHandler = (file: string, args: string[]) => Promise<ExecFileResult>;

export interface WorkspaceOpenTargetRuntime {
  applicationDirectories: string[];
  execFile: ExecFileHandler;
  platform: NodeJS.Platform;
}

interface MacWorkspaceOpenTargetDefinition {
  appName: string;
  bundleIds: string[];
  builtIn: boolean;
}

interface WorkspaceOpenTargetDefinition {
  id: WorkspaceOpenTargetId;
  label: string;
  macos: MacWorkspaceOpenTargetDefinition;
}

const WORKSPACE_OPEN_TARGET_DEFINITIONS: WorkspaceOpenTargetDefinition[] = [
  {
    id: "vscode",
    label: "VS Code",
    macos: {
      appName: "Visual Studio Code",
      bundleIds: ["com.microsoft.VSCode"],
      builtIn: false,
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    macos: {
      appName: "Cursor",
      // ToDesktop bundle IDs are generated; keep app-name path fallback below.
      bundleIds: ["com.todesktop.230313mzl4w4u92"],
      builtIn: false,
    },
  },
  {
    id: "sublime-text",
    label: "Sublime Text",
    macos: {
      appName: "Sublime Text",
      bundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
      builtIn: false,
    },
  },
  {
    id: "zed",
    label: "Zed",
    macos: {
      appName: "Zed",
      bundleIds: ["dev.zed.Zed"],
      builtIn: false,
    },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    macos: {
      appName: "Windsurf",
      bundleIds: ["com.exafunction.windsurf"],
      builtIn: false,
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    macos: {
      appName: "Antigravity",
      bundleIds: ["com.google.antigravity", "com.googlelabs.antigravity"],
      builtIn: false,
    },
  },
  {
    id: "finder",
    label: "Finder",
    macos: {
      appName: "Finder",
      bundleIds: ["com.apple.finder"],
      builtIn: true,
    },
  },
  {
    id: "terminal",
    label: "Terminal",
    macos: {
      appName: "Terminal",
      bundleIds: ["com.apple.Terminal"],
      builtIn: true,
    },
  },
  {
    id: "iterm2",
    label: "iTerm2",
    macos: {
      appName: "iTerm",
      bundleIds: ["com.googlecode.iterm2"],
      builtIn: false,
    },
  },
  {
    id: "ghostty",
    label: "Ghostty",
    macos: {
      appName: "Ghostty",
      bundleIds: ["com.mitchellh.ghostty"],
      builtIn: false,
    },
  },
  {
    id: "xcode",
    label: "Xcode",
    macos: {
      appName: "Xcode",
      bundleIds: ["com.apple.dt.Xcode"],
      builtIn: false,
    },
  },
];

function toWorkspaceOpenTarget(
  definition: WorkspaceOpenTargetDefinition,
): WorkspaceOpenTarget {
  return {
    id: definition.id,
    label: definition.label,
  };
}

async function defaultExecFile(
  file: string,
  args: string[],
): Promise<ExecFileResult> {
  const result = await execFileAsync(file, args);
  return {
    stdout: result.stdout,
  };
}

function createDefaultRuntime(): WorkspaceOpenTargetRuntime {
  const homeDirectory = os.homedir();
  return {
    applicationDirectories: [
      "/Applications",
      "/System/Applications",
      path.join(homeDirectory, "Applications"),
    ],
    execFile: defaultExecFile,
    platform: process.platform,
  };
}

function getMacApplicationCandidatePaths(
  definition: WorkspaceOpenTargetDefinition,
  runtime: WorkspaceOpenTargetRuntime,
): string[] {
  const appBundleName = `${definition.macos.appName}.app`;
  return runtime.applicationDirectories.map((directory) =>
    path.join(directory, appBundleName),
  );
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function hasMacBundleId(
  bundleId: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  try {
    const result = await runtime.execFile("mdfind", [
      `kMDItemCFBundleIdentifier == ${toMdfindStringLiteral(bundleId)}`,
    ]);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function toMdfindStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

async function hasMacApplicationPath(
  definition: WorkspaceOpenTargetDefinition,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  const candidatePaths = getMacApplicationCandidatePaths(definition, runtime);
  const results = await Promise.all(candidatePaths.map(pathExists));
  return results.some(Boolean);
}

async function isMacTargetAvailable(
  definition: WorkspaceOpenTargetDefinition,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  if (definition.macos.builtIn) {
    return true;
  }

  for (const bundleId of definition.macos.bundleIds) {
    if (await hasMacBundleId(bundleId, runtime)) {
      return true;
    }
  }

  return hasMacApplicationPath(definition, runtime);
}

function isWorkspaceOpenTarget(
  target: WorkspaceOpenTarget | null,
): target is WorkspaceOpenTarget {
  return target !== null;
}

export async function listWorkspaceOpenTargetsWithRuntime(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  if (runtime.platform !== "darwin") {
    return [];
  }

  const targets = await Promise.all(
    WORKSPACE_OPEN_TARGET_DEFINITIONS.map(async (definition) =>
      await isMacTargetAvailable(definition, runtime)
        ? toWorkspaceOpenTarget(definition)
        : null,
    ),
  );
  return targets.filter(isWorkspaceOpenTarget);
}

function findTargetDefinition(
  targetId: WorkspaceOpenTargetId,
): WorkspaceOpenTargetDefinition {
  const definition = WORKSPACE_OPEN_TARGET_DEFINITIONS.find(
    (candidate) => candidate.id === targetId,
  );
  if (!definition) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${targetId}`,
    });
  }
  return definition;
}

async function requireDirectory(directoryPath: string): Promise<void> {
  const stat = await fs.stat(directoryPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new WorkspaceOpenTargetError({
      code: "path_not_directory",
      message: `Workspace path is not a directory: ${directoryPath}`,
    });
  }
}

export async function openWorkspaceInTargetWithRuntime(
  args: WorkspaceOpenTargetLauncherArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  await requireDirectory(args.path);

  if (runtime.platform !== "darwin") {
    throw new WorkspaceOpenTargetError({
      code: "unsupported_platform",
      message: "Workspace open targets are not supported on this platform",
    });
  }

  const definition = findTargetDefinition(args.targetId);
  if (!(await isMacTargetAvailable(definition, runtime))) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${definition.label}`,
    });
  }

  await runtime.execFile("open", ["-a", definition.macos.appName, "--", args.path]);
}

export async function listWorkspaceOpenTargets(): Promise<WorkspaceOpenTarget[]> {
  return listWorkspaceOpenTargetsWithRuntime(createDefaultRuntime());
}

export async function openWorkspaceInTarget(
  args: WorkspaceOpenTargetLauncherArgs,
): Promise<void> {
  await openWorkspaceInTargetWithRuntime(args, createDefaultRuntime());
}
