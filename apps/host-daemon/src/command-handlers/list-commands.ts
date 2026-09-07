import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderNativeRoot,
  ProviderNativeRootSet,
  ProviderNativeRoots,
  ProviderResolvedNativeRoot,
} from "@bb/domain";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandOf,
} from "../command-dispatch-support.js";
import {
  discoverProviderCommands,
  isPathWithinDirectory,
  type CommandScanRoot,
} from "../command-discovery.js";

export interface DeclaredScanRootResolution {
  cwd: string | null;
  homeDir: string;
  providerId: string;
  nativeRoots: ProviderNativeRootSet;
}

type RootOrigin = "project" | "user";
type RootSide = "skills" | "commands";

interface ProjectAncestors {
  directories: string[];
  projectRootPath: string;
}

interface Workspace {
  cwd: string;
  ancestors: () => Promise<ProjectAncestors>;
}

async function hasProjectRootMarker(directoryPath: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(directoryPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectAncestorDirectories(
  cwd: string,
): Promise<ProjectAncestors> {
  const directories: string[] = [];
  let directoryPath = cwd;
  while (true) {
    directories.push(directoryPath);
    if (await hasProjectRootMarker(directoryPath)) {
      break;
    }
    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) {
      directories.splice(1);
      break;
    }
    directoryPath = parentPath;
  }

  const projectRootPath = directories.at(-1) ?? cwd;
  return { directories: directories.reverse(), projectRootPath };
}

function workspaceFor(cwd: string | null): Workspace | null {
  if (cwd === null) {
    return null;
  }
  let ancestors: Promise<ProjectAncestors> | null = null;
  return {
    cwd,
    ancestors: () => {
      ancestors ??= resolveProjectAncestorDirectories(cwd);
      return ancestors;
    },
  };
}

function skillIdentitySeed(
  providerId: string,
  origin: RootOrigin,
  identity: string,
): string {
  return `${providerId}:provider-${origin}:${identity}`;
}

function rootPathForDeduplication(root: CommandScanRoot): string {
  return "rootPath" in root ? root.rootPath : root.filePath;
}

function appendUniqueRoots(
  target: CommandScanRoot[],
  candidates: readonly CommandScanRoot[],
): void {
  const seen = new Set(target.map(rootPathForDeduplication));
  for (const candidate of candidates) {
    const candidatePath = rootPathForDeduplication(candidate);
    if (seen.has(candidatePath)) {
      continue;
    }
    seen.add(candidatePath);
    target.push(candidate);
  }
}

function toPosixRelativePath(fromPath: string, toPath: string): string {
  return path.relative(fromPath, toPath).split(path.sep).join("/");
}

function directoryScanRoot(args: {
  boundaryPath: string | null;
  identity: string;
  namePrefix: string;
  origin: RootOrigin;
  providerId: string;
  recursive: boolean;
  rootPath: string;
  side: RootSide;
  skipIfManifest: string | undefined;
}): CommandScanRoot {
  const boundary =
    args.boundaryPath === null ? {} : { boundaryPath: args.boundaryPath };
  const marker =
    args.skipIfManifest === undefined
      ? {}
      : { skipIfManifest: args.skipIfManifest };
  if (args.side === "commands") {
    return {
      ...boundary,
      rootPath: args.rootPath,
      shape: "command",
      namePrefix: args.namePrefix,
      source: "command",
      origin: args.origin,
    };
  }
  return {
    ...boundary,
    ...marker,
    rootPath: args.rootPath,
    shape: args.recursive ? "skill-recursive" : "skill",
    namePrefix: args.namePrefix,
    source: "skill",
    origin: args.origin,
    ...(args.namePrefix === ""
      ? {
          skillIdentitySeed: skillIdentitySeed(
            args.providerId,
            args.origin,
            args.identity,
          ),
        }
      : {}),
  };
}

async function ancestorScanRoots(args: {
  namePrefix: string;
  providerId: string;
  recursive: boolean;
  relativePath: string;
  side: RootSide;
  skipIfManifest: string | undefined;
  workspace: Workspace;
}): Promise<CommandScanRoot[]> {
  const { directories, projectRootPath } = await args.workspace.ancestors();
  return directories.map((directoryPath) =>
    directoryScanRoot({
      boundaryPath: projectRootPath,
      identity: `${args.relativePath}:${toPosixRelativePath(projectRootPath, directoryPath)}`,
      namePrefix: args.namePrefix,
      origin: "project",
      providerId: args.providerId,
      recursive: args.recursive,
      rootPath: path.join(directoryPath, args.relativePath),
      side: args.side,
      skipIfManifest: args.skipIfManifest,
    }),
  );
}

async function declaredProjectScanRoots(args: {
  entries: readonly ProviderNativeRoot[];
  providerId: string;
  side: RootSide;
  workspace: Workspace;
}): Promise<CommandScanRoot[]> {
  const roots: CommandScanRoot[] = [];
  for (const entry of args.entries) {
    if (entry.ancestors) {
      roots.push(
        ...(await ancestorScanRoots({
          namePrefix: entry.namePrefix,
          providerId: args.providerId,
          recursive: entry.recursive,
          skipIfManifest: entry.skipIfManifest,
          relativePath: entry.path,
          side: args.side,
          workspace: args.workspace,
        })),
      );
      continue;
    }
    roots.push(
      directoryScanRoot({
        boundaryPath: args.workspace.cwd,
        identity: entry.path,
        namePrefix: entry.namePrefix,
        origin: "project",
        providerId: args.providerId,
        recursive: entry.recursive,
        skipIfManifest: entry.skipIfManifest,
        rootPath: path.resolve(args.workspace.cwd, entry.path),
        side: args.side,
      }),
    );
  }
  return roots;
}

async function declaredScanRoots(args: {
  homeDir: string;
  providerId: string;
  roots: ProviderNativeRoots;
  side: RootSide;
  workspace: Workspace | null;
}): Promise<CommandScanRoot[]> {
  return [
    ...(args.workspace === null
      ? []
      : await declaredProjectScanRoots({
          entries: args.roots.project,
          providerId: args.providerId,
          side: args.side,
          workspace: args.workspace,
        })),
    ...args.roots.user.map((entry) =>
      directoryScanRoot({
        boundaryPath: null,
        identity: entry.path,
        namePrefix: entry.namePrefix,
        origin: "user",
        providerId: args.providerId,
        recursive: entry.recursive,
        skipIfManifest: entry.skipIfManifest,
        rootPath: path.resolve(args.homeDir, entry.path),
        side: args.side,
      }),
    ),
  ];
}

function resolvedSingleScanRoot(
  root: ProviderResolvedNativeRoot,
  providerId: string,
): CommandScanRoot | null {
  const seed =
    root.namePrefix === ""
      ? {
          skillIdentitySeed: skillIdentitySeed(
            providerId,
            root.origin,
            root.path,
          ),
        }
      : {};
  switch (root.shape) {
    case "skill":
      return {
        rootPath: root.path,
        shape: "skill-directory",
        namePrefix: root.namePrefix,
        source: "skill",
        origin: root.origin,
        ...seed,
      };
    case "skill-file":
      return {
        filePath: root.path,
        fallbackName:
          root.fallbackName ?? path.basename(path.dirname(root.path)),
        shape: "skill-file",
        namePrefix: root.namePrefix,
        source: "skill",
        origin: root.origin,
        ...seed,
      };
    case "command-file":
      return {
        filePath: root.path,
        shape: "command-file",
        namePrefix: root.namePrefix,
        source: "command",
        origin: root.origin,
      };
    case "skills":
    case "commands":
      return null;
  }
}

async function resolvedScanRoots(args: {
  providerId: string;
  roots: readonly ProviderResolvedNativeRoot[];
  side: RootSide;
  workspace: Workspace | null;
}): Promise<CommandScanRoot[]> {
  const roots: CommandScanRoot[] = [];
  for (const root of args.roots) {
    const single = resolvedSingleScanRoot(root, args.providerId);
    if (single !== null) {
      roots.push(single);
      continue;
    }
    const workspace = root.origin === "project" ? args.workspace : null;
    if (
      root.ancestors &&
      workspace !== null &&
      isPathWithinDirectory(workspace.cwd, root.path)
    ) {
      roots.push(
        ...(await ancestorScanRoots({
          namePrefix: root.namePrefix,
          providerId: args.providerId,
          recursive: root.recursive,
          skipIfManifest: root.skipIfManifest,
          relativePath: path.relative(workspace.cwd, root.path),
          side: args.side,
          workspace,
        })),
      );
      continue;
    }
    roots.push(
      directoryScanRoot({
        boundaryPath:
          workspace === null || root.origin !== "project"
            ? null
            : (await workspace.ancestors()).projectRootPath,
        identity: root.path,
        namePrefix: root.namePrefix,
        origin: root.origin,
        providerId: args.providerId,
        recursive: root.recursive,
        skipIfManifest: root.skipIfManifest,
        rootPath: root.path,
        side: args.side,
      }),
    );
  }
  return roots;
}

export async function resolveDeclaredScanRoots(
  resolution: DeclaredScanRootResolution,
): Promise<CommandScanRoot[]> {
  const { homeDir, nativeRoots, providerId } = resolution;
  const workspace = workspaceFor(resolution.cwd);
  const roots: CommandScanRoot[] = [];
  for (const side of ["skills", "commands"] as const) {
    appendUniqueRoots(
      roots,
      await declaredScanRoots({
        homeDir,
        providerId,
        roots: nativeRoots[side],
        side,
        workspace,
      }),
    );
  }
  for (const side of ["skills", "commands"] as const) {
    appendUniqueRoots(
      roots,
      await resolvedScanRoots({
        providerId,
        roots: nativeRoots.resolved[side],
        side,
        workspace,
      }),
    );
  }
  return roots;
}

export async function listHostCommands(
  command: CommandOf<"host.list_commands">,
): Promise<HostDaemonOnlineRpcResult<"host.list_commands">> {
  if (command.cwd !== null && !path.isAbsolute(command.cwd)) {
    throw new CommandDispatchError("invalid_path", "cwd must be absolute");
  }
  const roots = await resolveDeclaredScanRoots({
    cwd: command.cwd,
    homeDir: os.homedir(),
    providerId: command.providerId,
    nativeRoots: command.nativeRoots,
  });
  const commands = await discoverProviderCommands({ roots });
  return { commands };
}
