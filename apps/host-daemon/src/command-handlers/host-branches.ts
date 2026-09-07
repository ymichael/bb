import path from "node:path";
import type {
  GitBranchRefClassification,
  WorkspaceGitOperation,
} from "@bb/domain";
import {
  detectGitRepoKind,
  fetchRemoteBranches,
  getCheckoutRef,
  getGitCommonDir,
  getWorkspaceGitOperation,
  hasUncommittedChanges,
  listBranchRefsWithDefaults,
  readDefaultBranchRefs,
  type GitProcessOptions,
  withGitRefMutationLock,
} from "@bb/host-workspace";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type {
  CommandDispatchOptions,
  CommandOf,
} from "../command-dispatch-support.js";
import { userExecutableProcessOptions } from "../user-executable-env.js";

interface LimitBranchListArgs {
  branches: readonly string[];
  limit: number;
  query?: string;
}

interface LimitedBranchList {
  branches: string[];
  truncated: boolean;
}

interface PinBranchArgs {
  branches: readonly string[];
  branch: string | undefined;
}

interface ClassifySelectedBranchArgs {
  branches: readonly string[];
  remoteBranches: readonly string[];
  selectedBranch?: string;
}

interface ReadBranchOptionsArgs extends GitProcessOptions {
  path: string;
  limit: number;
  query?: string;
  selectedBranch?: string;
}

const REMOTE_BRANCH_FETCH_THROTTLE_MS = 30_000;
const REMOTE_BRANCH_FETCH_TIMEOUT_MS = 5_000;
const NO_GIT_OPERATION: WorkspaceGitOperation = { kind: "none" };

const remoteBranchFetchStateByCommonDir = new Map<
  string,
  { fetchedAt: number; inFlight: Promise<void> | null }
>();

function limitBranchList({
  branches,
  limit,
  query,
}: LimitBranchListArgs): LimitedBranchList {
  const normalizedQuery = query?.trim().toLowerCase();
  const filteredBranches =
    normalizedQuery && normalizedQuery.length > 0
      ? branches.filter((branch) =>
          branch.toLowerCase().includes(normalizedQuery),
        )
      : [...branches];
  return {
    branches: filteredBranches.slice(0, limit),
    truncated: filteredBranches.length > limit,
  };
}

function pinBranch({ branches, branch }: PinBranchArgs): string[] {
  if (!branch || !branches.includes(branch)) {
    return [...branches];
  }

  return [branch, ...branches.filter((candidate) => candidate !== branch)];
}

function classifySelectedBranch({
  branches,
  remoteBranches,
  selectedBranch,
}: ClassifySelectedBranchArgs): GitBranchRefClassification | null {
  if (!selectedBranch) {
    return null;
  }

  if (branches.includes(selectedBranch)) {
    return { name: selectedBranch, kind: "local" };
  }

  if (remoteBranches.includes(selectedBranch)) {
    return { name: selectedBranch, kind: "remote" };
  }

  return { name: selectedBranch, kind: "missing" };
}

async function refreshRemoteBranches(
  cwd: string,
  options: GitProcessOptions,
): Promise<void> {
  const commonDir = await getGitCommonDir(cwd, options);
  const now = Date.now();
  const existingState = remoteBranchFetchStateByCommonDir.get(commonDir);
  if (
    existingState &&
    now - existingState.fetchedAt < REMOTE_BRANCH_FETCH_THROTTLE_MS
  ) {
    if (existingState.inFlight) {
      await existingState.inFlight;
    }
    return;
  }

  if (existingState?.inFlight) {
    await existingState.inFlight;
    return;
  }

  const refreshDeadline = Date.now() + REMOTE_BRANCH_FETCH_TIMEOUT_MS;
  const inFlight = withGitRefMutationLock(
    commonDir,
    () => {
      const remainingTimeoutMs = Math.max(1, refreshDeadline - Date.now());
      return fetchRemoteBranches(cwd, {
        ...options,
        timeoutMs: remainingTimeoutMs,
      });
    },
    { timeoutMs: REMOTE_BRANCH_FETCH_TIMEOUT_MS },
  )
    .catch(() => undefined)
    .then(() => undefined)
    .finally(() => {
      remoteBranchFetchStateByCommonDir.set(commonDir, {
        fetchedAt: Date.now(),
        inFlight: null,
      });
    });

  remoteBranchFetchStateByCommonDir.set(commonDir, {
    fetchedAt: now,
    inFlight,
  });

  await inFlight;
}

async function readBranchOptions({
  path: cwd,
  limit,
  query,
  selectedBranch: requestedBranch,
  ...gitProcessOptions
}: ReadBranchOptionsArgs): Promise<
  HostDaemonOnlineRpcResult<"host.list_branch_options">
> {
  const { branches, defaultBranch, originDefaultBranch, remoteBranches } =
    await listBranchRefsWithDefaults(cwd, gitProcessOptions);
  const limitedBranches = limitBranchList({
    branches: pinBranch({ branches, branch: defaultBranch }),
    limit,
    query,
  });
  const limitedRemoteBranches = limitBranchList({
    branches: pinBranch({
      branches: remoteBranches,
      branch: originDefaultBranch,
    }),
    limit,
    query,
  });
  return {
    branches: limitedBranches.branches,
    branchesTruncated: limitedBranches.truncated,
    remoteBranches: limitedRemoteBranches.branches,
    remoteBranchesTruncated: limitedRemoteBranches.truncated,
    selectedBranch: classifySelectedBranch({
      branches,
      remoteBranches,
      selectedBranch: requestedBranch,
    }),
  };
}

export async function listHostBranchOptions(
  command: CommandOf<"host.list_branch_options">,
  options?: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<HostDaemonOnlineRpcResult<"host.list_branch_options">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const gitProcessOptions = userExecutableProcessOptions(
    options?.runtimeManager.getShellEnv() ?? {},
  );
  if ((await detectGitRepoKind(command.path, gitProcessOptions)) === "none") {
    return {
      branches: [],
      branchesTruncated: false,
      remoteBranches: [],
      remoteBranchesTruncated: false,
      selectedBranch: classifySelectedBranch({
        branches: [],
        remoteBranches: [],
        selectedBranch: command.selectedBranch,
      }),
    };
  }

  if (command.remoteRefresh === "background") {
    void refreshRemoteBranches(command.path, gitProcessOptions).catch(
      () => undefined,
    );
  }

  return readBranchOptions({ ...command, ...gitProcessOptions });
}

export async function inspectHostGitSource(
  command: CommandOf<"host.inspect_git_source">,
  options?: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<HostDaemonOnlineRpcResult<"host.inspect_git_source">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const gitProcessOptions = userExecutableProcessOptions(
    options?.runtimeManager.getShellEnv() ?? {},
  );
  const repoKind = await detectGitRepoKind(command.path, gitProcessOptions);
  if (repoKind === "none") {
    return {
      checkout: { kind: "unknown", reason: "Path is not a git repository" },
      defaultBranch: null,
      defaultBranchRelation: null,
      hasUncommittedChanges: false,
      operation: { kind: "none" },
      originDefaultBranch: null,
    };
  }

  if (command.remoteRefresh === "blocking") {
    await refreshRemoteBranches(command.path, gitProcessOptions);
  } else {
    void refreshRemoteBranches(command.path, gitProcessOptions).catch(
      () => undefined,
    );
  }

  const [checkout, defaultRefs, dirty, operation] = await Promise.all([
    getCheckoutRef(command.path, gitProcessOptions),
    readDefaultBranchRefs(command.path, gitProcessOptions),
    repoKind === "work-tree"
      ? hasUncommittedChanges(command.path, gitProcessOptions)
      : false,
    repoKind === "work-tree"
      ? getWorkspaceGitOperation(command.path, gitProcessOptions)
      : NO_GIT_OPERATION,
  ]);
  const defaultBranch = defaultRefs.defaultBranch;
  const originDefaultBranch = defaultRefs.originDefaultBranch;
  return {
    checkout,
    defaultBranch: defaultBranch ?? null,
    defaultBranchRelation: defaultRefs.defaultBranchRelation ?? null,
    hasUncommittedChanges: dirty,
    operation,
    originDefaultBranch: originDefaultBranch ?? null,
  };
}
