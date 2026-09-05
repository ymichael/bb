import {
  experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv,
  experimental_spawnPortableOutputProcess as spawnPortableOutputProcess,
} from "@get-bb/plugin-sdk/host";
import path from "node:path";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "WorkspaceError";
  }
}

export interface GitProcessOptions {
  shellPath?: string;
}

interface GitTimeoutOptions extends GitProcessOptions {
  timeoutMs?: number;
}

export interface RunGitOptions extends GitProcessOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRepositoryState = "not_git" | "no_commits" | "has_commits";

export type DefaultBranchRelation =
  | "equal"
  | "local-behind"
  | "local-ahead"
  | "diverged"
  | "unknown";

export interface DefaultBranchRefs {
  defaultBranch: string | undefined;
  defaultBranchRelation: DefaultBranchRelation | undefined;
  originDefaultBranch: string | undefined;
}

type GitRepoKind = "work-tree" | "bare" | "none";

interface GitOutputBuffer {
  append: (chunk: Buffer) => boolean;
  read: () => string;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function describeCommand(args: string[]): string {
  return `git ${args.join(" ")}`;
}

function createGitCommandCancelledError(
  args: string[],
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    `${describeCommand(args)} was cancelled`,
    { cause },
  );
}

function createGitCommandFailedError(
  args: string[],
  stderr: string,
  cause?: unknown,
): WorkspaceError {
  const detail = stderr ? `: ${stderr}` : "";
  return new WorkspaceError(
    "git_command_failed",
    `${describeCommand(args)} failed${detail}`,
    { cause },
  );
}

function resolveGitProcessEnv(options: RunGitOptions): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedChildProcessEnv({
      env: process.env,
      ...(options.shellPath !== undefined
        ? { shellPath: options.shellPath }
        : {}),
    }),
    ...options.env,
  };
}

function createGitOutputBuffer(): GitOutputBuffer {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    append(chunk: Buffer): boolean {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        return false;
      }
      chunks.push(chunk);
      return true;
    },
    read(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    return Promise.reject(
      createGitCommandCancelledError(args, options.signal.reason),
    );
  }

  return new Promise<GitCommandResult>((resolve, reject) => {
    const stdout = createGitOutputBuffer();
    const stderr = createGitOutputBuffer();
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawnPortableOutputProcess({
      command: "git",
      args,
      cwd: options.cwd,
      env: resolveGitProcessEnv(options),
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    const release = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: WorkspaceError): void => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      reject(error);
    };

    const succeed = (result: GitCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      resolve(result);
    };

    const readInto = (buffer: GitOutputBuffer) => {
      return (chunk: Buffer): void => {
        if (!buffer.append(chunk)) {
          overflowed = true;
          child.kill("SIGKILL");
        }
      };
    };

    child.stdout.on("data", readInto(stdout));
    child.stderr.on("data", readInto(stderr));

    child.on("error", (error) => {
      if (options.signal?.aborted) {
        fail(createGitCommandCancelledError(args, error));
        return;
      }
      if (options.allowFailure === true) {
        succeed({ stdout: "", stderr: "", exitCode: 1 });
        return;
      }
      fail(createGitCommandFailedError(args, "", error));
    });

    child.on("close", (code) => {
      if (options.signal?.aborted) {
        fail(createGitCommandCancelledError(args, options.signal.reason));
        return;
      }
      if (timedOut) {
        fail(
          new WorkspaceError(
            "git_command_timeout",
            `${describeCommand(args)} timed out after ${options.timeoutMs}ms`,
          ),
        );
        return;
      }
      if (overflowed) {
        fail(
          new WorkspaceError(
            "git_command_failed",
            `${describeCommand(args)} produced more than ${MAX_OUTPUT_BYTES} bytes of output`,
          ),
        );
        return;
      }
      const result: GitCommandResult = {
        stdout: stdout.read(),
        stderr: stderr.read(),
        exitCode: code ?? 1,
      };
      if (result.exitCode === 0 || options.allowFailure === true) {
        succeed(result);
        return;
      }
      fail(createGitCommandFailedError(args, trimOutput(result.stderr)));
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function getGitCommonDir(
  cwd: string,
  options: GitProcessOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const result = await runGit(["rev-parse", "--git-common-dir"], {
    cwd,
    ...options,
  });
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --git-common-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(cwd, commonDir);
}

async function detectGitRepoKind(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepoKind> {
  const result = await runGit(
    ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
    { cwd, ...options, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return "none";
  }
  const [insideWorkTree, bare] = trimOutput(result.stdout).split("\n");
  if (insideWorkTree === "true") {
    return "work-tree";
  }
  if (bare === "true") {
    return "bare";
  }
  return "none";
}

export async function detectGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) === "work-tree";
}

async function detectGitSource(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) !== "none";
}

async function ensureGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<void> {
  if (await detectGitSource(cwd, options)) {
    return;
  }

  throw new WorkspaceError(
    "not_git_repo",
    `Path is not a git repository: ${cwd}`,
  );
}

export async function readGitRepositoryState(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepositoryState> {
  if (!(await detectGitSource(cwd, options))) {
    return "not_git";
  }
  const result = await runGit(["rev-list", "--all", "--max-count=1"], {
    cwd,
    ...options,
  });
  return trimOutput(result.stdout).length > 0 ? "has_commits" : "no_commits";
}

export async function getCurrentBranch(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  if (!(await detectGitRepo(cwd, options))) {
    return undefined;
  }

  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const branchName = trimOutput(result.stdout);
  return branchName || undefined;
}

async function readLocalBranches(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string[]> {
  const branches = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd, ...options },
  );
  return branches.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function readDefaultBranch(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  await ensureGitRepo(cwd, options);

  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, ...options, allowFailure: true },
  );
  const remoteHead = trimOutput(originHead.stdout);
  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  const localBranches = await readLocalBranches(cwd, options);
  if (localBranches.includes("main")) {
    return "main";
  }
  if (localBranches.includes("master")) {
    return "master";
  }

  return localBranches[0];
}

export async function hasRef(
  cwd: string,
  ref: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    ...options,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

export async function findWorktreeForBranch(
  cwd: string,
  branchName: string,
  options: GitTimeoutOptions = {},
): Promise<string | null> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(["worktree", "list", "--porcelain"], {
    cwd,
    ...options,
  });
  let worktreePath: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length);
    } else if (
      line === `branch refs/heads/${branchName}` &&
      worktreePath !== null
    ) {
      return worktreePath;
    }
  }
  return null;
}

function resolvePreferredLocalDefaultBranch(
  localBranches: readonly string[],
  originDefaultBranchName: string | undefined,
): string | undefined {
  if (
    originDefaultBranchName &&
    localBranches.includes(originDefaultBranchName)
  ) {
    return originDefaultBranchName;
  }
  if (localBranches.includes("main")) {
    return "main";
  }
  if (localBranches.includes("master")) {
    return "master";
  }
  return localBranches[0];
}

async function readOriginHeadBranchName(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, ...options, allowFailure: true },
  );
  const remoteHead = trimOutput(originHead.stdout);
  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }
  return undefined;
}

async function readOriginDefaultBranch(
  cwd: string,
  localDefaultBranch: string | undefined,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const originHeadBranch = await readOriginHeadBranchName(cwd, options);
  if (
    originHeadBranch &&
    (await hasRef(cwd, `refs/remotes/origin/${originHeadBranch}`, options))
  ) {
    return `origin/${originHeadBranch}`;
  }

  if (
    localDefaultBranch &&
    (await hasRef(cwd, `refs/remotes/origin/${localDefaultBranch}`, options))
  ) {
    return `origin/${localDefaultBranch}`;
  }

  return undefined;
}

async function revParseRef(
  cwd: string,
  ref: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return trimOutput(result.stdout) || undefined;
}

async function isAncestorRef(
  cwd: string,
  ancestorRef: string,
  descendantRef: string,
  options: GitTimeoutOptions = {},
): Promise<boolean | undefined> {
  const result = await runGit(
    ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
    { cwd, ...options, allowFailure: true },
  );
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  return undefined;
}

async function readDefaultBranchRelation(
  cwd: string,
  localDefaultBranch: string | undefined,
  originDefaultBranch: string | undefined,
  options: GitTimeoutOptions = {},
): Promise<DefaultBranchRelation | undefined> {
  if (!localDefaultBranch || !originDefaultBranch) {
    return undefined;
  }

  const localRef = `refs/heads/${localDefaultBranch}`;
  const originRef = `refs/remotes/${originDefaultBranch}`;
  const [localSha, originSha] = await Promise.all([
    revParseRef(cwd, localRef, options),
    revParseRef(cwd, originRef, options),
  ]);
  if (!localSha || !originSha) {
    return "unknown";
  }
  if (localSha === originSha) {
    return "equal";
  }

  const localIsAncestor = await isAncestorRef(
    cwd,
    localRef,
    originRef,
    options,
  );
  if (localIsAncestor === true) {
    return "local-behind";
  }
  if (localIsAncestor === undefined) {
    return "unknown";
  }

  const originIsAncestor = await isAncestorRef(
    cwd,
    originRef,
    localRef,
    options,
  );
  if (originIsAncestor === true) {
    return "local-ahead";
  }
  if (originIsAncestor === undefined) {
    return "unknown";
  }

  return "diverged";
}

export async function readDefaultBranchRefs(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<DefaultBranchRefs> {
  await ensureGitRepo(cwd, options);
  const originHeadBranch = await readOriginHeadBranchName(cwd, options);
  const localBranches = await readLocalBranches(cwd, options);
  const defaultBranch = resolvePreferredLocalDefaultBranch(
    localBranches,
    originHeadBranch,
  );
  const originDefaultBranch = await readOriginDefaultBranch(
    cwd,
    defaultBranch,
    options,
  );
  const defaultBranchRelation = await readDefaultBranchRelation(
    cwd,
    defaultBranch,
    originDefaultBranch,
    options,
  );

  return {
    defaultBranch,
    defaultBranchRelation,
    originDefaultBranch,
  };
}
