import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import type { RuntimeManager } from "../runtime-manager.js";
import {
  CommandDispatchError,
  requireWorkspaceEnvironment,
} from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";

const execFileAsync = promisify(execFile);

export async function listWorkspaceFiles(
  command: CommandOf<"workspace.list_files">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.list_files">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const workspacePath = entry.workspace.path;

  let filePaths: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 },
    );
    filePaths = stdout.split("\n").filter((line) => line.length > 0);
  } catch {
    filePaths = await listFilesRecursively(workspacePath, workspacePath);
  }

  if (command.query) {
    const lowerQuery = command.query.toLowerCase();
    filePaths = filePaths.filter((p) => p.toLowerCase().includes(lowerQuery));
  }

  return {
    files: filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
    })),
  };
}

async function listFilesRecursively(
  dir: string,
  root: string,
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(fullPath, root)));
    } else {
      results.push(path.relative(root, fullPath));
    }
  }
  return results;
}

export async function readWorkspaceFile(
  command: CommandOf<"workspace.read_file">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.read_file">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const workspacePath = entry.workspace.path;

  const resolved = path.resolve(workspacePath, command.path);
  if (!resolved.startsWith(workspacePath + path.sep) && resolved !== workspacePath) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${command.path}" escapes workspace root`,
    );
  }

  const content = await fs.readFile(resolved, "utf-8");
  return {
    path: command.path,
    content,
  };
}

export async function listBranches(
  command: CommandOf<"workspace.list_branches">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.list_branches">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const branches = await entry.workspace.getBranches();
  const current = await entry.workspace.currentBranch();
  return { branches, current };
}
