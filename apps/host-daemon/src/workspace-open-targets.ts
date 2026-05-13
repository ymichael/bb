import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetKind,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";

const execFileAsync = promisify(execFile);

export type WorkspaceOpenTargetErrorCode =
  | "path_not_found"
  | "path_not_openable"
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

export interface OpenPathInTargetArgs {
  lineNumber: number | null;
  path: string;
  targetId: WorkspaceOpenTargetId;
}

interface ExecFileResult {
  stdout: string;
}

type ExecFileHandler = (
  file: string,
  args: string[],
) => Promise<ExecFileResult>;

export interface WorkspaceOpenTargetRuntime {
  applicationDirectories: string[];
  execFile: ExecFileHandler;
  platform: NodeJS.Platform;
}

interface MacWorkspaceOpenTargetDefinition {
  appName: string;
  bundleIds: string[];
  builtIn: boolean;
  lineOpenCommand?: MacLineOpenCommandDefinition;
}

interface WorkspaceOpenTargetDefinition {
  fileOpenBehavior: "direct" | "containing-directory";
  id: WorkspaceOpenTargetId;
  kind: WorkspaceOpenTargetKind;
  label: string;
  macos: MacWorkspaceOpenTargetDefinition;
}

interface ExecFileInvocation {
  args: string[];
  file: string;
}

interface BuildMacLineOpenArgs {
  lineNumber: number;
  path: string;
}

interface MacLineOpenCommandDefinition {
  executable: string;
  toArgs: (args: BuildMacLineOpenArgs) => string[];
}

interface ResolveMacOpenInvocationArgs {
  definition: WorkspaceOpenTargetDefinition;
  existingPath: ExistingPath;
  lineNumber: number | null;
}

interface ResolveTargetOpenPathArgs {
  definition: WorkspaceOpenTargetDefinition;
  existingPath: ExistingPath;
}

function formatPathWithLineNumber(args: BuildMacLineOpenArgs): string {
  return `${args.path}:${args.lineNumber}`;
}

const WORKSPACE_OPEN_TARGET_DEFINITIONS: WorkspaceOpenTargetDefinition[] = [
  {
    id: "vscode",
    kind: "editor",
    label: "VS Code",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Visual Studio Code",
      bundleIds: ["com.microsoft.VSCode"],
      builtIn: false,
      lineOpenCommand: {
        executable: "code",
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
    },
  },
  {
    id: "cursor",
    kind: "editor",
    label: "Cursor",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Cursor",
      // ToDesktop bundle IDs are generated; keep app-name path fallback below.
      bundleIds: ["com.todesktop.230313mzl4w4u92"],
      builtIn: false,
      lineOpenCommand: {
        executable: "cursor",
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
    },
  },
  {
    id: "sublime-text",
    kind: "editor",
    label: "Sublime Text",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Sublime Text",
      bundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
      builtIn: false,
      lineOpenCommand: {
        executable: "subl",
        toArgs: (args) => [formatPathWithLineNumber(args)],
      },
    },
  },
  {
    id: "zed",
    kind: "editor",
    label: "Zed",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Zed",
      bundleIds: ["dev.zed.Zed"],
      builtIn: false,
      lineOpenCommand: {
        executable: "zed",
        toArgs: (args) => [formatPathWithLineNumber(args)],
      },
    },
  },
  {
    id: "windsurf",
    kind: "editor",
    label: "Windsurf",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Windsurf",
      bundleIds: ["com.exafunction.windsurf"],
      builtIn: false,
      lineOpenCommand: {
        executable: "windsurf",
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
    },
  },
  {
    id: "antigravity",
    kind: "editor",
    label: "Antigravity",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Antigravity",
      bundleIds: ["com.google.antigravity", "com.googlelabs.antigravity"],
      builtIn: false,
    },
  },
  {
    id: "finder",
    kind: "file-browser",
    label: "Finder",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Finder",
      bundleIds: ["com.apple.finder"],
      builtIn: true,
    },
  },
  {
    id: "terminal",
    kind: "terminal",
    label: "Terminal",
    fileOpenBehavior: "containing-directory",
    macos: {
      appName: "Terminal",
      bundleIds: ["com.apple.Terminal"],
      builtIn: true,
    },
  },
  {
    id: "iterm2",
    kind: "terminal",
    label: "iTerm2",
    fileOpenBehavior: "containing-directory",
    macos: {
      appName: "iTerm",
      bundleIds: ["com.googlecode.iterm2"],
      builtIn: false,
    },
  },
  {
    id: "ghostty",
    kind: "terminal",
    label: "Ghostty",
    fileOpenBehavior: "containing-directory",
    macos: {
      appName: "Ghostty",
      bundleIds: ["com.mitchellh.ghostty"],
      builtIn: false,
    },
  },
  {
    id: "xcode",
    kind: "editor",
    label: "Xcode",
    fileOpenBehavior: "direct",
    macos: {
      appName: "Xcode",
      bundleIds: ["com.apple.dt.Xcode"],
      builtIn: false,
      lineOpenCommand: {
        executable: "xed",
        toArgs: (args) => ["-l", String(args.lineNumber), args.path],
      },
    },
  },
];

function toWorkspaceOpenTarget(
  definition: WorkspaceOpenTargetDefinition,
): WorkspaceOpenTarget {
  return {
    id: definition.id,
    kind: definition.kind,
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
      (await isMacTargetAvailable(definition, runtime))
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

interface ExistingPath {
  path: string;
  type: "directory" | "file";
}

async function requireOpenablePath(targetPath: string): Promise<ExistingPath> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) {
    throw new WorkspaceOpenTargetError({
      code: "path_not_found",
      message: `Open target path does not exist: ${targetPath}`,
    });
  }

  if (stat.isDirectory()) {
    return {
      path: targetPath,
      type: "directory",
    };
  }

  if (stat.isFile()) {
    return {
      path: targetPath,
      type: "file",
    };
  }

  throw new WorkspaceOpenTargetError({
    code: "path_not_openable",
    message: `Open target path must be a file or directory: ${targetPath}`,
  });
}

function resolveTargetOpenPath(args: ResolveTargetOpenPathArgs): string {
  if (
    args.existingPath.type === "file" &&
    args.definition.fileOpenBehavior === "containing-directory"
  ) {
    return path.dirname(args.existingPath.path);
  }

  return args.existingPath.path;
}

async function isExecutableAvailable(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  try {
    await runtime.execFile("which", [executable]);
    return true;
  } catch {
    return false;
  }
}

async function maybeResolveMacLineOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation | null> {
  if (args.lineNumber === null || args.existingPath.type !== "file") {
    return null;
  }

  const lineOpenCommand = args.definition.macos.lineOpenCommand;
  if (!lineOpenCommand) {
    return null;
  }

  if (!(await isExecutableAvailable(lineOpenCommand.executable, runtime))) {
    return null;
  }

  return {
    file: lineOpenCommand.executable,
    args: lineOpenCommand.toArgs({
      lineNumber: args.lineNumber,
      path: args.existingPath.path,
    }),
  };
}

async function resolveMacOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const lineOpenInvocation = await maybeResolveMacLineOpenInvocation(
    args,
    runtime,
  );
  if (lineOpenInvocation) {
    return lineOpenInvocation;
  }

  return {
    file: "open",
    args: [
      "-a",
      args.definition.macos.appName,
      "--",
      resolveTargetOpenPath({
        definition: args.definition,
        existingPath: args.existingPath,
      }),
    ],
  };
}

export async function openPathInTargetWithRuntime(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
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

  const existingPath = await requireOpenablePath(args.path);
  const invocation = await resolveMacOpenInvocation(
    {
      definition,
      existingPath,
      lineNumber: args.lineNumber,
    },
    runtime,
  );
  await runtime.execFile(invocation.file, invocation.args);
}

export async function listWorkspaceOpenTargets(): Promise<
  WorkspaceOpenTarget[]
> {
  return listWorkspaceOpenTargetsWithRuntime(createDefaultRuntime());
}

export async function openPathInTarget(
  args: OpenPathInTargetArgs,
): Promise<void> {
  await openPathInTargetWithRuntime(args, createDefaultRuntime());
}
