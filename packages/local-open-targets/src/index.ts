import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  WORKSPACE_OPEN_TARGET_ICON_DATA_URL_MAX_LENGTH,
  type WorkspaceOpenTarget,
  type WorkspaceOpenTargetIcon,
  type WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import { sanitizeInheritedChildProcessEnv } from "@bb/process-utils";
import {
  BASIC_FILE_OPEN_CAPABILITIES,
  FILE_MANAGER_OPEN_CAPABILITIES,
  TERMINAL_OPEN_CAPABILITIES,
} from "./capabilities.js";
import { WorkspaceOpenTargetError } from "./errors.js";
import { LAUNCH_ADAPTERS } from "./macos-launch-adapters.js";
import {
  buildLocalTerminalShellArgs,
  buildRemoteTerminalSshArgs,
} from "./terminal.js";
import type {
  BuildMacRemoteSshOpenArgs,
  BuildMacTerminalOpenArgs,
  DiscoveredMacApplication,
  ExecFileOptions,
  ExecFileResult,
  ExecFileInvocation,
  ExistingPath,
  LaunchAdapter,
  LinuxDesktopApplication,
  MacBundledExecutableAdapter,
  ListWorkspaceOpenTargetsOptions,
  MacRemoteSshOpenCommandAdapter,
  MacCommandExecutableAdapter,
  OpenPathInTargetArgs,
  PlatformOpenInvocationArgs,
  PlatformRemoteSshOpenInvocationArgs,
  ResolveMacOpenInvocationArgs,
  ResolveMacRemoteSshOpenInvocationArgs,
  ResolveMacTargetIconArgs,
  ResolveTargetOpenPathArgs,
  WorkspaceOpenTargetRuntime,
} from "./types.js";

interface MacCommandAdapter extends MacCommandExecutableAdapter {
  fallbackExecutables?: MacCommandExecutableAdapter[];
}

interface ResolvedMacCommandExecutable {
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
  file: string;
}

export { WorkspaceOpenTargetError } from "./errors.js";
export type {
  ListWorkspaceOpenTargetsOptions,
  OpenPathInTargetArgs,
  WorkspaceOpenTargetRuntime,
} from "./types.js";

export interface WorkspaceOpenTargetRuntimeOptions {
  shellPath?: string;
}

const execFileAsync = promisify(execFile);
const DESKTOP_APP_TARGET_ID_PREFIX = "desktop-app:";
const MAC_APP_TARGET_ID_PREFIX = "mac-app:";
const MAC_FILE_APPLICATION_DISCOVERY_LIMIT = 5;
const MAC_APPLICATION_ICON_THUMBNAIL_SIZE_PX = 32;
const TERMINAL_EDITOR_CANDIDATES = ["nvim", "vim", "nano", "less"] as const;
const MAC_APPLICATIONS_FOR_FILE_SCRIPT = `
function run(argv) {
  ObjC.import("AppKit");
  const filePath = argv[0];
  const url = $.NSURL.fileURLWithPath(filePath);
  const applications = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);
  const output = [];
  for (let index = 0; index < applications.count; index += 1) {
    const applicationUrl = applications.objectAtIndex(index);
    const bundle = $.NSBundle.bundleWithURL(applicationUrl);
    const bundleId = bundle ? ObjC.unwrap(bundle.bundleIdentifier) : null;
    output.push({
      appPath: ObjC.unwrap(applicationUrl.path),
      bundleId,
    });
  }
  return JSON.stringify(output);
}
`;
const macApplicationsForFileResultSchema = z.array(
  z
    .object({
      appPath: z.string().min(1),
      bundleId: z.string().min(1).nullable(),
    })
    .strict(),
);

async function toWorkspaceOpenTarget(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  appPath: string | null,
): Promise<WorkspaceOpenTarget> {
  const target: WorkspaceOpenTarget = {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    icon: await resolveMacTargetIcon({
      appPath,
      definition,
      runtime,
    }),
    capabilities: definition.capabilities,
  };
  if (
    definition.macos.openMode !== "default-app" &&
    definition.macos.remoteSshOpenCommand !== undefined &&
    (await findUnavailableMacRemoteSshExecutable(
      definition,
      definition.macos.remoteSshOpenCommand,
      runtime,
    )) === null
  ) {
    target.remoteSshCapabilities =
      definition.macos.remoteSshOpenCommand.capabilities;
  }
  return target;
}

function toCliWorkspaceOpenTarget(
  definition: LaunchAdapter,
): WorkspaceOpenTarget {
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    icon: definition.icon,
    capabilities: definition.capabilities,
    ...(definition.macos.openMode !== "default-app" &&
    definition.macos.remoteSshOpenCommand !== undefined
      ? {
          remoteSshCapabilities:
            definition.macos.remoteSshOpenCommand.capabilities,
        }
      : {}),
  };
}

async function toGenericMacApplicationOpenTarget(
  application: DiscoveredMacApplication & { bundleId: string },
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget> {
  const iconDataUrl = await resolveMacApplicationIconDataUrl(
    application.appPath,
    runtime,
  );
  return {
    id: encodeMacApplicationTargetId(application.bundleId),
    label: application.label,
    kind: "native-app",
    icon:
      iconDataUrl === null
        ? { kind: "symbol", name: "app" }
        : { kind: "data-url", dataUrl: iconDataUrl },
    capabilities: BASIC_FILE_OPEN_CAPABILITIES,
  };
}

function encodeMacApplicationTargetId(bundleId: string): WorkspaceOpenTargetId {
  return `${MAC_APP_TARGET_ID_PREFIX}${bundleId}`;
}

function parseMacApplicationTargetId(
  targetId: WorkspaceOpenTargetId,
): string | null {
  return targetId.startsWith(MAC_APP_TARGET_ID_PREFIX)
    ? targetId.slice(MAC_APP_TARGET_ID_PREFIX.length)
    : null;
}

function encodeDesktopApplicationTargetId(
  desktopFileId: string,
): WorkspaceOpenTargetId {
  return `${DESKTOP_APP_TARGET_ID_PREFIX}${desktopFileId}`;
}

function parseDesktopApplicationTargetId(
  targetId: WorkspaceOpenTargetId,
): string | null {
  return targetId.startsWith(DESKTOP_APP_TARGET_ID_PREFIX)
    ? targetId.slice(DESKTOP_APP_TARGET_ID_PREFIX.length)
    : null;
}

function findLaunchAdapterByBundleId(bundleId: string): LaunchAdapter | null {
  return (
    LAUNCH_ADAPTERS.find(
      (adapter) =>
        adapter.macos.openMode === "application" &&
        adapter.macos.bundleIds.includes(bundleId),
    ) ?? null
  );
}

function findLaunchAdapterForMacApplication(
  application: DiscoveredMacApplication,
): LaunchAdapter | null {
  if (application.bundleId !== null) {
    const bundleIdAdapter = findLaunchAdapterByBundleId(application.bundleId);
    if (bundleIdAdapter !== null) {
      return bundleIdAdapter;
    }
  }

  return (
    LAUNCH_ADAPTERS.find(
      (adapter) =>
        adapter.macos.openMode === "application" &&
        [adapter.macos.appName, ...(adapter.macos.additionalAppNames ?? [])]
          .map((candidate) => candidate.toLowerCase())
          .includes(application.label.toLowerCase()),
    ) ?? null
  );
}

function getCliOpenExecutable(adapter: LaunchAdapter): string | null {
  if (adapter.macos.openMode === "default-app") {
    return null;
  }
  return (
    adapter.macos.pathOpenCommand?.executable ??
    adapter.macos.lineOpenCommand?.executable ??
    null
  );
}

async function isCliTargetAvailable(
  adapter: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  if (adapter.macos.openMode === "default-app") {
    return false;
  }
  const executable = getCliOpenExecutable(adapter);
  return executable === null
    ? false
    : isExecutableAvailable(executable, runtime);
}

async function listCliWorkspaceOpenTargets(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  const targets = await Promise.all(
    LAUNCH_ADAPTERS.map(async (adapter) => {
      if (!(await isCliTargetAvailable(adapter, runtime))) {
        return null;
      }
      return toCliWorkspaceOpenTarget(adapter);
    }),
  );
  return targets.filter(isWorkspaceOpenTarget);
}

async function getDefaultOpenExecutable(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  if (runtime.platform === "linux") {
    if (
      isWslRuntime(runtime) &&
      (await isExecutableAvailable("wslview", runtime))
    ) {
      return "wslview";
    }
    return (await isExecutableAvailable("xdg-open", runtime))
      ? "xdg-open"
      : null;
  }

  return null;
}

async function getFileManagerExecutable(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  if (runtime.platform === "linux") {
    if (
      isWslRuntime(runtime) &&
      (await isExecutableAvailable("explorer.exe", runtime))
    ) {
      return "explorer.exe";
    }
    return (await isExecutableAvailable("xdg-open", runtime))
      ? "xdg-open"
      : null;
  }

  return null;
}

async function getTerminalExecutable(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const candidates =
    runtime.platform === "linux"
      ? ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
      : [];

  for (const candidate of candidates) {
    if (await isExecutableAvailable(candidate, runtime)) {
      return candidate;
    }
  }

  return null;
}

async function listPlatformWorkspaceOpenTargets(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  const targets: WorkspaceOpenTarget[] = [];
  if (await getDefaultOpenExecutable(runtime)) {
    targets.push({
      id: "default-app",
      label: "Default App",
      kind: "default-app",
      icon: { kind: "symbol", name: "default-app" },
      capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    });
  }

  if (await getFileManagerExecutable(runtime)) {
    targets.push({
      id: "file-manager",
      label: "File Manager",
      kind: "file-manager",
      icon: { kind: "symbol", name: "file-manager" },
      capabilities: FILE_MANAGER_OPEN_CAPABILITIES,
    });
  }

  const terminalExecutable = await getTerminalExecutable(runtime);
  if (terminalExecutable !== null) {
    targets.push({
      id: "terminal",
      label: "Terminal",
      kind: "terminal",
      icon: { kind: "symbol", name: "terminal" },
      capabilities: TERMINAL_OPEN_CAPABILITIES,
    });
  }

  return targets;
}

function parseDesktopEntryValue(line: string): [string, string] | null {
  const separatorIndex = line.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }
  return [
    line.slice(0, separatorIndex).trim(),
    line.slice(separatorIndex + 1).trim(),
  ];
}

const LINUX_WORKSPACE_APPLICATION_CATEGORIES = new Set([
  "FileManager",
  "TerminalEmulator",
  "TextEditor",
]);

function parseDesktopEntryList(value: string | undefined): string[] {
  return value?.split(";").filter(Boolean) ?? [];
}

function parseLinuxDesktopApplication(
  desktopFilePath: string,
  content: string,
): LinuxDesktopApplication | null {
  let inDesktopEntry = false;
  const fields = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry) {
      continue;
    }
    const parsed = parseDesktopEntryValue(line);
    if (parsed !== null) {
      fields.set(parsed[0], parsed[1]);
    }
  }

  if (
    fields.get("Type") !== "Application" ||
    fields.get("Hidden") === "true" ||
    fields.get("NoDisplay") === "true"
  ) {
    return null;
  }

  const label = fields.get("Name");
  const exec = fields.get("Exec");
  const categories = parseDesktopEntryList(fields.get("Categories"));
  if (
    !label ||
    !exec ||
    !categories.some((category) =>
      LINUX_WORKSPACE_APPLICATION_CATEGORIES.has(category),
    )
  ) {
    return null;
  }

  return {
    desktopFileId: path.basename(desktopFilePath, ".desktop"),
    desktopFilePath,
    exec,
    label,
  };
}

async function listLinuxDesktopApplications(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<LinuxDesktopApplication[]> {
  const applications: LinuxDesktopApplication[] = [];
  const seenIds = new Set<string>();
  for (const directory of runtime.desktopFileDirectories ?? []) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".desktop")) {
        continue;
      }
      const desktopFilePath = path.join(directory, entry.name);
      const desktopFileId = path.basename(desktopFilePath, ".desktop");
      if (seenIds.has(desktopFileId)) {
        continue;
      }
      const content = await fs
        .readFile(desktopFilePath, "utf8")
        .catch(() => null);
      if (content === null) {
        continue;
      }
      const application = parseLinuxDesktopApplication(
        desktopFilePath,
        content,
      );
      if (application === null) {
        continue;
      }
      seenIds.add(desktopFileId);
      applications.push(application);
    }
  }
  return applications.sort((a, b) => a.label.localeCompare(b.label));
}

function toLinuxDesktopApplicationOpenTarget(
  application: LinuxDesktopApplication,
): WorkspaceOpenTarget {
  return {
    id: encodeDesktopApplicationTargetId(application.desktopFileId),
    label: application.label,
    kind: "native-app",
    icon: { kind: "symbol", name: "app" },
    capabilities: BASIC_FILE_OPEN_CAPABILITIES,
  };
}

async function defaultExecFile(
  file: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<ExecFileResult> {
  const result = await execFileAsync(file, args, {
    env: sanitizeInheritedChildProcessEnv({ env: options?.env ?? process.env }),
  });
  return {
    stdout: result.stdout,
  };
}

async function execInvocation(
  invocation: ExecFileInvocation,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  await runtime.execFile(invocation.file, invocation.args, {
    env: invocation.env,
  });
}

export function createWorkspaceOpenTargetRuntime(
  options: WorkspaceOpenTargetRuntimeOptions = {},
): WorkspaceOpenTargetRuntime {
  const homeDirectory = os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.shellPath !== undefined ? { PATH: options.shellPath } : {}),
  };
  return {
    applicationDirectories: [
      "/Applications",
      "/System/Applications",
      path.join(homeDirectory, "Applications"),
    ],
    desktopFileDirectories: [
      "/usr/share/applications",
      "/usr/local/share/applications",
      path.join(homeDirectory, ".local/share/applications"),
    ],
    env,
    execFile: defaultExecFile,
    platform: process.platform,
  };
}

function getMacApplicationCandidatePaths(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): string[] {
  if (definition.macos.openMode === "default-app") {
    return [];
  }

  const appNames = [
    definition.macos.appName,
    ...(definition.macos.additionalAppNames ?? []),
  ];
  return appNames.flatMap((appName) =>
    runtime.applicationDirectories.map((directory) =>
      path.join(directory, `${appName}.app`),
    ),
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

function isWslRuntime(runtime: WorkspaceOpenTargetRuntime): boolean {
  return (
    runtime.platform === "linux" &&
    (runtime.env?.WSL_DISTRO_NAME !== undefined ||
      runtime.env?.WSL_INTEROP !== undefined)
  );
}

async function readMacApplicationInfoPlistValue(
  appPath: string,
  key: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  try {
    const result = await runtime.execFile("plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ]);
    const value = result.stdout.trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

async function resolveMacApplicationIconDataUrl(
  appPath: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const iconFile = await readMacApplicationInfoPlistValue(
    appPath,
    "CFBundleIconFile",
    runtime,
  );
  if (iconFile === null) {
    return null;
  }

  const iconFileName =
    path.extname(iconFile) === "" ? `${iconFile}.icns` : iconFile;
  const iconPath = path.join(appPath, "Contents", "Resources", iconFileName);
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-open-target-icon-"),
  );
  const pngPath = path.join(tempDir, `${path.basename(iconPath)}.png`);
  try {
    await runtime.execFile("qlmanage", [
      "-t",
      "-s",
      String(MAC_APPLICATION_ICON_THUMBNAIL_SIZE_PX),
      "-o",
      tempDir,
      iconPath,
    ]);
    const iconBytes = await fs.readFile(pngPath);
    const dataUrl = `data:image/png;base64,${iconBytes.toString("base64")}`;
    return dataUrl.length > WORKSPACE_OPEN_TARGET_ICON_DATA_URL_MAX_LENGTH
      ? null
      : dataUrl;
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function resolveMacTargetIcon({
  appPath,
  definition,
  runtime,
}: ResolveMacTargetIconArgs): Promise<WorkspaceOpenTargetIcon> {
  if (
    appPath !== null &&
    definition.macos.openMode === "application" &&
    !definition.macos.builtIn
  ) {
    const iconDataUrl = await resolveMacApplicationIconDataUrl(
      appPath,
      runtime,
    );
    if (iconDataUrl !== null) {
      return { kind: "data-url", dataUrl: iconDataUrl };
    }
  }

  return definition.icon;
}

async function hasMacBundleId(
  bundleId: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  return (
    (await findMacApplicationPathsByBundleId(bundleId, runtime)).length > 0
  );
}

async function findMacApplicationPathsByBundleId(
  bundleId: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string[]> {
  try {
    const result = await runtime.execFile("mdfind", [
      `kMDItemCFBundleIdentifier == ${toMdfindStringLiteral(bundleId)}`,
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function toMdfindStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

async function hasMacApplicationPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  return (await findMacApplicationPath(definition, runtime)) !== null;
}

function sortNewestNameFirst(entries: string[]): string[] {
  return [...entries].sort((a, b) => b.localeCompare(a));
}

async function findJetBrainsToolboxApplicationPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  if (
    definition.macos.openMode === "default-app" ||
    definition.macos.jetBrainsToolbox === undefined
  ) {
    return null;
  }

  const toolboxRoot = path.join(
    runtime.env?.HOME ?? os.homedir(),
    "Library",
    "Application Support",
    "JetBrains",
    "Toolbox",
    "apps",
  );
  const pending: Array<{ depth: number; directory: string }> = [
    { directory: toolboxRoot, depth: 0 },
  ];

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current.depth > 5) {
      continue;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entryName of sortNewestNameFirst(
      entries.map((entry) => entry.name),
    )) {
      const entry = entries.find((candidate) => candidate.name === entryName);
      if (entry === undefined || !entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(current.directory, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (
        lowerName.endsWith(".app") &&
        definition.macos.jetBrainsToolbox.bundlePrefixes.some((prefix) =>
          lowerName.startsWith(prefix),
        )
      ) {
        const executablePath = path.join(
          entryPath,
          "Contents",
          "MacOS",
          definition.macos.jetBrainsToolbox.executable,
        );
        if (await pathExists(executablePath)) {
          return entryPath;
        }
      }

      pending.push({
        directory: entryPath,
        depth: current.depth + 1,
      });
    }
  }

  return null;
}

async function findMacApplicationPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  if (definition.macos.openMode === "default-app") {
    return null;
  }

  for (const bundleId of definition.macos.bundleIds) {
    const paths = await findMacApplicationPathsByBundleId(bundleId, runtime);
    const appPath = paths.find((candidate) => candidate.endsWith(".app"));
    if (appPath) {
      return appPath;
    }
  }

  const candidatePaths = getMacApplicationCandidatePaths(definition, runtime);
  const results = await Promise.all(candidatePaths.map(pathExists));
  const index = results.findIndex(Boolean);
  if (index !== -1) {
    return candidatePaths[index];
  }

  return findJetBrainsToolboxApplicationPath(definition, runtime);
}

async function findMacApplicationPathByBundleId(
  bundleId: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const paths = await findMacApplicationPathsByBundleId(bundleId, runtime);
  return paths.find((candidate) => candidate.endsWith(".app")) ?? null;
}

async function readMacApplicationLabel(
  appPath: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string> {
  return (
    (await readMacApplicationInfoPlistValue(
      appPath,
      "CFBundleDisplayName",
      runtime,
    )) ??
    (await readMacApplicationInfoPlistValue(
      appPath,
      "CFBundleName",
      runtime,
    )) ??
    path.basename(appPath, ".app")
  );
}

async function listMacApplicationsForFilePath(
  filePath: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<DiscoveredMacApplication[]> {
  if (!(await pathExists(filePath))) {
    return [];
  }

  let parsedApplications: z.infer<typeof macApplicationsForFileResultSchema>;
  try {
    const result = await runtime.execFile("osascript", [
      "-l",
      "JavaScript",
      "-e",
      MAC_APPLICATIONS_FOR_FILE_SCRIPT,
      "--",
      filePath,
    ]);
    parsedApplications = macApplicationsForFileResultSchema.parse(
      JSON.parse(result.stdout.trim()),
    );
  } catch {
    return [];
  }

  const applications: DiscoveredMacApplication[] = [];
  const seenBundleIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const application of parsedApplications) {
    if (!application.appPath.endsWith(".app")) {
      continue;
    }
    if (
      application.bundleId !== null &&
      seenBundleIds.has(application.bundleId)
    ) {
      continue;
    }
    if (application.bundleId === null && seenPaths.has(application.appPath)) {
      continue;
    }

    if (application.bundleId === null) {
      seenPaths.add(application.appPath);
    } else {
      seenBundleIds.add(application.bundleId);
    }

    applications.push({
      appPath: application.appPath,
      bundleId: application.bundleId,
      label: await readMacApplicationLabel(application.appPath, runtime),
    });
    if (applications.length >= MAC_FILE_APPLICATION_DISCOVERY_LIMIT) {
      break;
    }
  }

  return applications;
}

async function isMacTargetAvailable(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  if (definition.macos.openMode === "default-app") {
    return true;
  }

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

async function listKnownMacWorkspaceOpenTargets(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  const targets: WorkspaceOpenTarget[] = [];
  for (const adapter of LAUNCH_ADAPTERS) {
    if (adapter.macos.openMode === "default-app" || adapter.macos.builtIn) {
      targets.push(await toWorkspaceOpenTarget(adapter, runtime, null));
      continue;
    }

    const appPath = await findMacApplicationPath(adapter, runtime);
    if (appPath !== null) {
      targets.push(await toWorkspaceOpenTarget(adapter, runtime, appPath));
    }
  }
  return targets;
}

export async function listWorkspaceOpenTargetsWithRuntime(
  runtime: WorkspaceOpenTargetRuntime,
  options: ListWorkspaceOpenTargetsOptions = {},
): Promise<WorkspaceOpenTarget[]> {
  if (runtime.platform !== "darwin") {
    if (runtime.platform !== "linux") {
      return [];
    }
    return [
      ...(await listCliWorkspaceOpenTargets(runtime)),
      ...(await listPlatformWorkspaceOpenTargets(runtime)),
      ...(await listLinuxDesktopApplications(runtime)).map(
        toLinuxDesktopApplicationOpenTarget,
      ),
    ];
  }

  const targets: WorkspaceOpenTarget[] = [];
  const seenTargetIds = new Set<WorkspaceOpenTargetId>();
  const pushTarget = (target: WorkspaceOpenTarget): void => {
    if (seenTargetIds.has(target.id)) {
      return;
    }
    seenTargetIds.add(target.id);
    targets.push(target);
  };

  for (const target of await listKnownMacWorkspaceOpenTargets(runtime)) {
    pushTarget(target);
  }

  const pathSpecificApplications =
    options.path === undefined
      ? []
      : await listMacApplicationsForFilePath(options.path, runtime);
  for (const application of pathSpecificApplications) {
    const adapter = findLaunchAdapterForMacApplication(application);
    if (adapter !== null) {
      pushTarget(
        await toWorkspaceOpenTarget(adapter, runtime, application.appPath),
      );
      continue;
    }
    if (application.bundleId !== null) {
      pushTarget(
        await toGenericMacApplicationOpenTarget(
          { ...application, bundleId: application.bundleId },
          runtime,
        ),
      );
    }
  }

  return targets;
}

function findLaunchAdapter(
  targetId: WorkspaceOpenTargetId,
): LaunchAdapter | null {
  return LAUNCH_ADAPTERS.find((candidate) => candidate.id === targetId) ?? null;
}

function requireLaunchAdapter(targetId: WorkspaceOpenTargetId): LaunchAdapter {
  const definition = findLaunchAdapter(targetId);
  if (!definition) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${targetId}`,
    });
  }
  return definition;
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
    await runtime.execFile("which", [executable], { env: runtime.env });
    return true;
  } catch {
    return false;
  }
}

async function isServiceExecutableAvailable(
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

function isMacServiceExecutable(executable: string): boolean {
  return executable === "open" || executable === "osascript";
}

async function resolveMacBundledExecutable(
  definition: LaunchAdapter,
  bundledExecutable: MacBundledExecutableAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ResolvedMacCommandExecutable | null> {
  const appPath = await findMacApplicationPath(definition, runtime);
  if (appPath === null) {
    return null;
  }

  const executablePath = path.join(
    appPath,
    ...bundledExecutable.relativeExecutablePath,
  );
  if (!(await pathExists(executablePath))) {
    return null;
  }

  for (const relativePath of bundledExecutable.requiredRelativePaths ?? []) {
    if (!(await pathExists(path.join(appPath, ...relativePath)))) {
      return null;
    }
  }

  return {
    file: executablePath,
    argsPrefix: bundledExecutable.toArgsPrefix?.(appPath) ?? [],
    env: bundledExecutable.toEnv?.(runtime.env) ?? runtime.env,
  };
}

async function resolveMacCommandExecutable(
  definition: LaunchAdapter,
  command: MacCommandAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ResolvedMacCommandExecutable | null> {
  for (const candidate of [command, ...(command.fallbackExecutables ?? [])]) {
    const serviceExecutable = isMacServiceExecutable(candidate.executable);
    const available = serviceExecutable
      ? await isServiceExecutableAvailable(candidate.executable, runtime)
      : await isExecutableAvailable(candidate.executable, runtime);
    if (available) {
      return {
        file: candidate.executable,
        argsPrefix: [],
        ...(serviceExecutable ? {} : { env: runtime.env }),
      };
    }
    if (candidate.bundledExecutable !== undefined) {
      const resolved = await resolveMacBundledExecutable(
        definition,
        candidate.bundledExecutable,
        runtime,
      );
      if (resolved !== null) {
        return resolved;
      }
    }
  }
  return null;
}

async function resolveTerminalEditorCommand(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const visual = runtime.env?.VISUAL?.trim();
  if (visual) {
    return visual;
  }

  const editor = runtime.env?.EDITOR?.trim();
  if (editor) {
    return editor;
  }

  for (const candidate of TERMINAL_EDITOR_CANDIDATES) {
    if (await isExecutableAvailable(candidate, runtime)) {
      return candidate;
    }
  }

  return null;
}

async function findUnavailableMacRemoteSshExecutable(
  definition: LaunchAdapter,
  command: MacRemoteSshOpenCommandAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  for (const executable of command.requiredExecutables ?? []) {
    if (!(await isExecutableAvailable(executable, runtime))) {
      return executable;
    }
  }

  return (await resolveMacCommandExecutable(definition, command, runtime)) ===
    null
    ? command.executable
    : null;
}

async function maybeResolveMacLineOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation | null> {
  if (args.lineNumber === null || args.existingPath.type !== "file") {
    return null;
  }

  if (args.definition.macos.openMode === "default-app") {
    return null;
  }

  const lineOpenCommand = args.definition.macos.lineOpenCommand;
  if (!lineOpenCommand) {
    return null;
  }

  const commandExecutable = await resolveMacCommandExecutable(
    args.definition,
    lineOpenCommand,
    runtime,
  );
  if (commandExecutable === null) {
    return null;
  }

  return {
    file: commandExecutable.file,
    args: [
      ...commandExecutable.argsPrefix,
      ...lineOpenCommand.toArgs({
        columnNumber: lineOpenCommand.supportsColumn ? args.columnNumber : null,
        lineNumber: args.lineNumber,
        path: args.existingPath.path,
      }),
    ],
    env: commandExecutable.env,
  };
}

async function maybeResolveMacPathOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation | null> {
  if (args.definition.macos.openMode === "default-app") {
    return null;
  }

  const pathOpenCommand = args.definition.macos.pathOpenCommand;
  if (!pathOpenCommand) {
    return null;
  }

  const commandExecutable = await resolveMacCommandExecutable(
    args.definition,
    pathOpenCommand,
    runtime,
  );
  if (commandExecutable === null) {
    return null;
  }

  const openPath = resolveTargetOpenPath({
    definition: args.definition,
    existingPath: args.existingPath,
  });
  return {
    file: commandExecutable.file,
    args: [
      ...commandExecutable.argsPrefix,
      ...pathOpenCommand.toArgs(openPath),
    ],
    env: commandExecutable.env,
  };
}

async function maybeResolveMacFileOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation | null> {
  if (
    args.definition.macos.openMode === "default-app" ||
    args.existingPath.type !== "file"
  ) {
    return null;
  }

  const fileOpenCommand = args.definition.macos.fileOpenCommand;
  if (!fileOpenCommand) {
    return null;
  }

  if (
    !(await isServiceExecutableAvailable(fileOpenCommand.executable, runtime))
  ) {
    return null;
  }

  return {
    file: fileOpenCommand.executable,
    args: fileOpenCommand.toArgs(args.existingPath.path),
  };
}

async function maybeResolveMacLocalTerminalOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation | null> {
  if (args.definition.macos.openMode === "default-app") {
    return null;
  }

  const localTerminalOpenCommand =
    args.definition.macos.localTerminalOpenCommand;
  if (!localTerminalOpenCommand) {
    return null;
  }

  return {
    file: localTerminalOpenCommand.executable,
    args: localTerminalOpenCommand.toArgs({
      columnNumber: args.definition.capabilities.openFileAtColumn
        ? args.columnNumber
        : null,
      editorCommand:
        args.existingPath.type === "file"
          ? await resolveTerminalEditorCommand(runtime)
          : null,
      lineNumber: args.lineNumber,
      path: args.existingPath.path,
      pathType: args.existingPath.type,
      shellPath: runtime.env?.SHELL?.trim() || "/bin/zsh",
    }),
  };
}

async function resolveXcodeXedPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  if (await isExecutableAvailable("xed", runtime)) {
    return "xed";
  }

  try {
    const result = await runtime.execFile("xcode-select", ["-p"]);
    const developerPath = result.stdout.trim();
    if (developerPath.length > 0) {
      const selectedXedPath = path.join(developerPath, "usr", "bin", "xed");
      if (await pathExists(selectedXedPath)) {
        return selectedXedPath;
      }
    }
  } catch {}

  const appPath = await findMacApplicationPath(definition, runtime);
  if (appPath === null) {
    return null;
  }

  const bundledXedPath = path.join(
    appPath,
    "Contents",
    "Developer",
    "usr",
    "bin",
    "xed",
  );
  return (await pathExists(bundledXedPath)) ? bundledXedPath : null;
}

async function findXcodeContainerPath(
  existingPath: ExistingPath,
): Promise<string | null> {
  let directory =
    existingPath.type === "directory"
      ? existingPath.path
      : path.dirname(existingPath.path);
  let packageDirectory: string | null = null;

  for (;;) {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      entries = [];
    }

    const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
    if (workspace !== undefined) {
      return path.join(directory, workspace);
    }

    const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
    if (project !== undefined) {
      return path.join(directory, project);
    }

    if (packageDirectory === null && entries.includes("Package.swift")) {
      packageDirectory = directory;
    }

    const parentDirectory = path.dirname(directory);
    if (parentDirectory === directory) {
      return packageDirectory;
    }
    directory = parentDirectory;
  }
}

async function maybeResolveXcodeOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation | null> {
  if (args.definition.id !== "xcode") {
    return null;
  }

  const xedPath = await resolveXcodeXedPath(args.definition, runtime);
  if (xedPath === null) {
    return null;
  }

  const xcodeContainerPath = await findXcodeContainerPath(args.existingPath);
  return {
    file: xedPath,
    args: [
      ...(xcodeContainerPath === null ? [] : ["--project", xcodeContainerPath]),
      ...(args.lineNumber === null || args.existingPath.type !== "file"
        ? []
        : ["--line", String(args.lineNumber)]),
      args.existingPath.path,
    ],
    env: runtime.env,
  };
}

async function resolveMacOpenInvocation(
  args: ResolveMacOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const xcodeOpenInvocation = await maybeResolveXcodeOpenInvocation(
    args,
    runtime,
  );
  if (xcodeOpenInvocation) {
    return xcodeOpenInvocation;
  }

  const lineOpenInvocation = await maybeResolveMacLineOpenInvocation(
    args,
    runtime,
  );
  if (lineOpenInvocation) {
    return lineOpenInvocation;
  }

  const fileOpenInvocation = await maybeResolveMacFileOpenInvocation(
    args,
    runtime,
  );
  if (fileOpenInvocation) {
    return fileOpenInvocation;
  }

  const pathOpenInvocation = await maybeResolveMacPathOpenInvocation(
    args,
    runtime,
  );
  if (pathOpenInvocation) {
    return pathOpenInvocation;
  }

  const localTerminalOpenInvocation =
    await maybeResolveMacLocalTerminalOpenInvocation(args, runtime);
  if (localTerminalOpenInvocation) {
    return localTerminalOpenInvocation;
  }

  const openPath = resolveTargetOpenPath({
    definition: args.definition,
    existingPath: args.existingPath,
  });
  if (args.definition.macos.openMode === "default-app") {
    return {
      file: "open",
      args: ["--", openPath],
    };
  }

  return {
    file: "open",
    args: ["-a", args.definition.macos.appName, "--", openPath],
  };
}

async function resolveMacRemoteSshOpenInvocation(
  args: ResolveMacRemoteSshOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  if (args.definition.macos.openMode === "default-app") {
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.definition.label} cannot open remote SSH paths`,
    });
  }

  const remoteSshOpenCommand = args.definition.macos.remoteSshOpenCommand;
  if (remoteSshOpenCommand === undefined) {
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.definition.label} cannot open remote SSH paths`,
    });
  }

  const unavailableExecutable = await findUnavailableMacRemoteSshExecutable(
    args.definition,
    remoteSshOpenCommand,
    runtime,
  );
  if (unavailableExecutable !== null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `${args.definition.label} remote SSH opener is unavailable: ${unavailableExecutable}`,
    });
  }

  const commandExecutable = await resolveMacCommandExecutable(
    args.definition,
    remoteSshOpenCommand,
    runtime,
  );
  if (commandExecutable === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `${args.definition.label} remote SSH opener is unavailable: ${remoteSshOpenCommand.executable}`,
    });
  }

  return {
    file: commandExecutable.file,
    args: [
      ...commandExecutable.argsPrefix,
      ...remoteSshOpenCommand.toArgs({
        columnNumber: remoteSshOpenCommand.capabilities.openFileAtColumn
          ? args.columnNumber
          : null,
        lineNumber: remoteSshOpenCommand.capabilities.openFileAtLine
          ? args.lineNumber
          : null,
        path: args.path,
        sshAuthority: args.sshAuthority,
      }),
    ],
    env: commandExecutable.env,
  };
}

async function resolveGenericMacApplicationOpenInvocation(
  args: {
    bundleId: string;
    existingPath: ExistingPath;
  },
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const appPath = await findMacApplicationPathByBundleId(
    args.bundleId,
    runtime,
  );
  if (appPath === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${args.bundleId}`,
    });
  }

  return {
    file: "open",
    args: ["-b", args.bundleId, "--", args.existingPath.path],
  };
}

async function resolveCliOpenInvocation(
  args: PlatformOpenInvocationArgs & {
    definition: LaunchAdapter;
  },
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const lineOpenInvocation = await maybeResolveMacLineOpenInvocation(
    args,
    runtime,
  );
  if (lineOpenInvocation) {
    return lineOpenInvocation;
  }

  const pathOpenInvocation = await maybeResolveMacPathOpenInvocation(
    args,
    runtime,
  );
  if (pathOpenInvocation) {
    return pathOpenInvocation;
  }

  throw new WorkspaceOpenTargetError({
    code: "target_unavailable",
    message: `Workspace open target is unavailable: ${args.definition.label}`,
  });
}

async function resolvePlatformDefaultOpenInvocation(
  args: PlatformOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const executable = await getDefaultOpenExecutable(runtime);
  if (executable === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: "Default app opener is unavailable",
    });
  }

  return {
    file: executable,
    args: [args.existingPath.path],
    env: runtime.env,
  };
}

async function resolvePlatformFileManagerOpenInvocation(
  args: PlatformOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const executable = await getFileManagerExecutable(runtime);
  if (executable === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: "File manager opener is unavailable",
    });
  }

  const openPath =
    args.existingPath.type === "file"
      ? path.dirname(args.existingPath.path)
      : args.existingPath.path;
  return {
    file: executable,
    args: [openPath],
    env: runtime.env,
  };
}

function buildLinuxTerminalOpenInvocation(
  executable: string,
  args: BuildMacTerminalOpenArgs,
): ExecFileInvocation {
  const shellArgs = buildLocalTerminalShellArgs(args);
  if (executable === "gnome-terminal") {
    return { file: executable, args: ["--", ...shellArgs] };
  }
  return { file: executable, args: ["-e", ...shellArgs] };
}

function buildLinuxTerminalRemoteSshInvocation(
  executable: string,
  args: BuildMacRemoteSshOpenArgs,
): ExecFileInvocation {
  const shellArgs = buildRemoteTerminalSshArgs(args);
  if (executable === "gnome-terminal") {
    return { file: executable, args: ["--", ...shellArgs] };
  }
  return { file: executable, args: ["-e", ...shellArgs] };
}

async function resolvePlatformTerminalOpenInvocation(
  args: PlatformOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const executable = await getTerminalExecutable(runtime);
  if (executable === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: "Terminal opener is unavailable",
    });
  }

  return {
    ...buildLinuxTerminalOpenInvocation(executable, {
      columnNumber: args.columnNumber,
      lineNumber: args.lineNumber,
      path: args.existingPath.path,
      pathType: args.existingPath.type,
    }),
    env: runtime.env,
  };
}

async function resolvePlatformTerminalRemoteSshOpenInvocation(
  args: PlatformRemoteSshOpenInvocationArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const executable = await getTerminalExecutable(runtime);
  if (executable === null || !(await isExecutableAvailable("ssh", runtime))) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: "Terminal remote SSH opener is unavailable",
    });
  }

  if (runtime.platform !== "linux") {
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: "Terminal remote SSH opener is unsupported on this platform",
    });
  }

  return {
    ...buildLinuxTerminalRemoteSshInvocation(executable, args),
    env: runtime.env,
  };
}

function splitDesktopExec(exec: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of exec) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) {
    current += "\\";
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function expandDesktopExecToken(
  token: string,
  args: {
    application: LinuxDesktopApplication;
    path: string;
  },
): { token: string; usedPath: boolean } | null {
  let usedPath = false;
  const expanded = token.replaceAll(/%[a-zA-Z%]/gu, (fieldCode) => {
    switch (fieldCode) {
      case "%%":
        return "%";
      case "%f":
      case "%F":
      case "%u":
      case "%U":
        usedPath = true;
        return args.path;
      case "%c":
        return args.application.label;
      case "%k":
        return args.application.desktopFilePath;
      case "%i":
        return "";
      default:
        return "";
    }
  });
  return expanded.length === 0 ? null : { token: expanded, usedPath };
}

function buildLinuxDesktopApplicationInvocation(
  application: LinuxDesktopApplication,
  targetPath: string,
): ExecFileInvocation {
  const rawTokens = splitDesktopExec(application.exec);
  const tokens: string[] = [];
  let usedPath = false;
  for (const rawToken of rawTokens) {
    const expanded = expandDesktopExecToken(rawToken, {
      application,
      path: targetPath,
    });
    if (expanded === null) {
      continue;
    }
    tokens.push(expanded.token);
    usedPath ||= expanded.usedPath;
  }
  if (tokens.length === 0) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Desktop app opener is unavailable: ${application.label}`,
    });
  }
  if (!usedPath) {
    tokens.push(targetPath);
  }
  return {
    file: tokens[0] ?? application.exec,
    args: tokens.slice(1),
  };
}

async function findLinuxDesktopApplication(
  desktopFileId: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<LinuxDesktopApplication | null> {
  return (
    (await listLinuxDesktopApplications(runtime)).find(
      (application) => application.desktopFileId === desktopFileId,
    ) ?? null
  );
}

async function resolveLinuxDesktopApplicationOpenInvocation(
  args: {
    desktopFileId: string;
    existingPath: ExistingPath;
  },
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  const application = await findLinuxDesktopApplication(
    args.desktopFileId,
    runtime,
  );
  if (application === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${args.desktopFileId}`,
    });
  }
  return {
    ...buildLinuxDesktopApplicationInvocation(
      application,
      args.existingPath.path,
    ),
    env: runtime.env,
  };
}

async function resolvePlatformOpenInvocation(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<ExecFileInvocation> {
  if (runtime.platform !== "linux") {
    throw new WorkspaceOpenTargetError({
      code: "unsupported_platform",
      message: "Workspace open targets are not supported on this platform",
    });
  }

  const desktopFileId = parseDesktopApplicationTargetId(args.targetId);
  if (args.context.kind === "remote-ssh") {
    if (desktopFileId !== null) {
      throw new WorkspaceOpenTargetError({
        code: "remote_target_unsupported",
        message: `${args.targetId} cannot open remote SSH paths`,
      });
    }
    if (args.targetId === "terminal") {
      return resolvePlatformTerminalRemoteSshOpenInvocation(
        {
          columnNumber: args.columnNumber,
          lineNumber: args.lineNumber,
          path: args.path,
          sshAuthority: args.context.sshAuthority,
        },
        runtime,
      );
    }

    const definition = findLaunchAdapter(args.targetId);
    if (
      definition !== null &&
      definition.macos.openMode !== "default-app" &&
      definition.macos.remoteSshOpenCommand !== undefined
    ) {
      return resolveMacRemoteSshOpenInvocation(
        {
          definition,
          columnNumber: args.columnNumber,
          lineNumber: args.lineNumber,
          path: args.path,
          sshAuthority: args.context.sshAuthority,
        },
        runtime,
      );
    }

    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.targetId} cannot open remote SSH paths`,
    });
  }

  const existingPath = await requireOpenablePath(args.path);
  if (desktopFileId !== null) {
    return resolveLinuxDesktopApplicationOpenInvocation(
      { desktopFileId, existingPath },
      runtime,
    );
  }

  const platformArgs: PlatformOpenInvocationArgs = {
    columnNumber: args.columnNumber,
    existingPath,
    lineNumber: args.lineNumber,
  };
  const definition = findLaunchAdapter(args.targetId);
  if (
    definition !== null &&
    (await isCliTargetAvailable(definition, runtime))
  ) {
    return resolveCliOpenInvocation(
      {
        ...platformArgs,
        definition,
      },
      runtime,
    );
  }

  if (args.targetId === "default-app") {
    return resolvePlatformDefaultOpenInvocation(platformArgs, runtime);
  }
  if (args.targetId === "file-manager") {
    return resolvePlatformFileManagerOpenInvocation(platformArgs, runtime);
  }
  if (args.targetId === "terminal") {
    return resolvePlatformTerminalOpenInvocation(platformArgs, runtime);
  }

  throw new WorkspaceOpenTargetError({
    code: "target_unavailable",
    message: `Workspace open target is unavailable: ${args.targetId}`,
  });
}

export async function openPathInTargetWithRuntime(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  if (runtime.platform !== "darwin") {
    const invocation = await resolvePlatformOpenInvocation(args, runtime);
    await execInvocation(invocation, runtime);
    return;
  }

  const genericMacBundleId = parseMacApplicationTargetId(args.targetId);
  if (genericMacBundleId !== null) {
    if (args.context.kind === "remote-ssh") {
      throw new WorkspaceOpenTargetError({
        code: "remote_target_unsupported",
        message: `${args.targetId} cannot open remote SSH paths`,
      });
    }
    const invocation = await resolveGenericMacApplicationOpenInvocation(
      {
        bundleId: genericMacBundleId,
        existingPath: await requireOpenablePath(args.path),
      },
      runtime,
    );
    await execInvocation(invocation, runtime);
    return;
  }

  const definition = requireLaunchAdapter(args.targetId);
  if (!(await isMacTargetAvailable(definition, runtime))) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${definition.label}`,
    });
  }

  if (args.context.kind === "remote-ssh") {
    const invocation = await resolveMacRemoteSshOpenInvocation(
      {
        definition,
        columnNumber: args.columnNumber,
        lineNumber: args.lineNumber,
        path: args.path,
        sshAuthority: args.context.sshAuthority,
      },
      runtime,
    );
    await execInvocation(invocation, runtime);
    return;
  }

  const existingPath = await requireOpenablePath(args.path);
  const invocation = await resolveMacOpenInvocation(
    {
      definition,
      columnNumber: args.columnNumber,
      existingPath,
      lineNumber: args.lineNumber,
    },
    runtime,
  );
  await execInvocation(invocation, runtime);
}

export async function listWorkspaceOpenTargets(
  options: ListWorkspaceOpenTargetsOptions = {},
): Promise<WorkspaceOpenTarget[]> {
  return listWorkspaceOpenTargetsWithRuntime(
    createWorkspaceOpenTargetRuntime(),
    options,
  );
}

export async function openPathInTarget(
  args: OpenPathInTargetArgs,
): Promise<void> {
  await openPathInTargetWithRuntime(args, createWorkspaceOpenTargetRuntime());
}
