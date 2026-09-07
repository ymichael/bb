import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ACP_BRIDGE_MCP_SERVER_NAME,
  type AcpMcpServerConfig,
} from "./tool-proxy-mcp.js";

const CURSOR_MCP_APPROVAL_FILE = "mcp-approvals.json";
const CURSOR_APPROVAL_LOCK_STALE_MS = 30_000;
const CURSOR_APPROVAL_LOCK_TIMEOUT_MS = 5_000;

export interface CursorMcpApproval {
  approval: string;
  installedByBb: boolean;
  path: string;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function cursorAgentCommand(command: string): boolean {
  return (
    basename(command)
      .toLowerCase()
      .replace(/\.(?:bat|cmd|exe)$/u, "") === "cursor-agent"
  );
}

function cursorProjectSlug(projectRoot: string): string {
  return projectRoot
    .replace(/[^a-zA-Z0-9]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function cursorDataDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.CURSOR_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".cursor");
}

function cursorMcpServerConfig(config: AcpMcpServerConfig): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: config.command,
    args: config.args,
    env: Object.fromEntries(config.env.map(({ name, value }) => [name, value])),
  };
}

export function buildCursorMcpApprovalIdentifier(args: {
  config: AcpMcpServerConfig;
  projectRoot: string;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        path: args.projectRoot,
        server: cursorMcpServerConfig(args.config),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${args.config.name}-${fingerprint}`;
}

async function resolveCursorProjectRoot(args: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string> {
  return new Promise((resolveRoot) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: args.cwd, env: args.env, windowsHide: true },
      (error, stdout) => {
        const root = stdout.trim();
        resolveRoot(error === null && root !== "" ? root : resolve(args.cwd));
      },
    );
  });
}

async function readApprovals(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Cursor MCP approval file is not a string array: ${path}`);
  }
  return value;
}

async function writeApprovals(path: string, approvals: readonly string[]) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.bb-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(approvals, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function acquireApprovalLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.bb-lock`;
  const deadline = Date.now() + CURSOR_APPROVAL_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > CURSOR_APPROVAL_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out updating Cursor MCP approvals: ${path}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function mutateApprovals(
  path: string,
  mutate: (approvals: string[]) => string[],
): Promise<void> {
  const releaseLock = await acquireApprovalLock(path);
  try {
    const approvals = await readApprovals(path);
    const nextApprovals = mutate(approvals);
    if (
      approvals.length !== nextApprovals.length ||
      approvals.some((approval, index) => approval !== nextApprovals[index])
    ) {
      await writeApprovals(path, nextApprovals);
    }
  } finally {
    await releaseLock();
  }
}

export async function approveCursorSessionMcpServer(args: {
  agentCommand: string;
  config: AcpMcpServerConfig;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<CursorMcpApproval | undefined> {
  if (
    !cursorAgentCommand(args.agentCommand) ||
    args.config.name !== ACP_BRIDGE_MCP_SERVER_NAME
  ) {
    return undefined;
  }
  const projectRoot = await resolveCursorProjectRoot({
    cwd: args.cwd,
    env: args.env,
  });
  const path = join(
    cursorDataDirectory(args.env),
    "projects",
    cursorProjectSlug(projectRoot),
    CURSOR_MCP_APPROVAL_FILE,
  );
  const approval = buildCursorMcpApprovalIdentifier({
    config: args.config,
    projectRoot,
  });
  let installedByBb = false;
  await mutateApprovals(path, (approvals) => {
    if (approvals.includes(approval)) {
      return approvals;
    }
    installedByBb = true;
    return [...approvals, approval];
  });
  return { approval, installedByBb, path };
}

export async function revokeCursorSessionMcpServer(
  approval: CursorMcpApproval,
): Promise<void> {
  if (!approval.installedByBb) {
    return;
  }
  await mutateApprovals(approval.path, (approvals) =>
    approvals.filter((candidate) => candidate !== approval.approval),
  );
}
