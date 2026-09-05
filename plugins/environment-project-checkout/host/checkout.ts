import {
  detectGitRepo,
  runGit,
  WorkspaceError,
  type GitProcessOptions,
} from "bb-environment-provider-host/git";
import { tryWithCheckoutMutationLock } from "bb-environment-provider-host/locks";
import {
  emitStep,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";
import {
  getCheckoutRef,
  getWorkspaceGitOperation,
  hasUncommittedChanges,
  listLocalBranches,
  pathExists,
} from "./git.js";
import type { CheckoutBranch, CheckoutInspection } from "../contract.js";

interface AttachCheckoutArgs {
  path: string;
  branch: CheckoutBranch | null;
  shellPath?: string | undefined;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
}

export interface AttachedCheckout {
  path: string;
  branchName: string | null;
}

function checkoutLabel(
  branch: CheckoutBranch,
  phase: "waiting" | "ready" | "doing" | "done" | "failed",
): string {
  const verb =
    branch.kind === "new"
      ? {
          waiting: "Waiting to create",
          ready: "Ready to create",
          doing: "Creating",
          done: "Created",
          failed: "Failed to create",
        }[phase]
      : {
          waiting: "Waiting to switch to",
          ready: "Ready to switch to",
          doing: "Switching to",
          done: "Switched to",
          failed: "Failed to switch to",
        }[phase];
  return `${verb} branch ${branch.name}`;
}

async function assertSwitchable(
  cwd: string,
  branch: CheckoutBranch,
  options: GitProcessOptions,
): Promise<"already-current" | "ready"> {
  const ref = await getCheckoutRef(cwd, options);
  if (
    (ref.kind === "branch" || ref.kind === "unborn") &&
    ref.branchName === branch.name
  ) {
    return "already-current";
  }
  switch (ref.kind) {
    case "branch":
      break;
    case "detached":
      throw new WorkspaceError(
        "checkout_detached",
        "Cannot checkout branch while the workspace is on a detached HEAD",
      );
    case "unborn":
      throw new WorkspaceError(
        "checkout_unborn",
        "Cannot checkout branch before the current branch has an initial commit",
      );
    case "unknown":
      throw new WorkspaceError(
        "checkout_unknown",
        `Cannot inspect current checkout: ${ref.reason}`,
      );
  }
  if (branch.kind === "existing") {
    const branches = await listLocalBranches(cwd, options);
    if (!branches.includes(branch.name)) {
      throw new WorkspaceError(
        "checkout_missing_branch",
        `Cannot checkout missing branch ${branch.name}`,
      );
    }
  }
  const operation = await getWorkspaceGitOperation(cwd, options);
  if (operation.kind !== "none" && operation.hasConflicts) {
    throw new WorkspaceError(
      "checkout_conflicts",
      `Cannot checkout branch while ${operation.kind} has unresolved conflicts`,
    );
  }
  if (operation.kind !== "none") {
    throw new WorkspaceError(
      "checkout_in_progress_operation",
      `Cannot checkout branch while ${operation.kind} is in progress`,
    );
  }
  if (await hasUncommittedChanges(cwd, options)) {
    throw new WorkspaceError(
      "checkout_dirty",
      "Cannot checkout branch while the workspace has uncommitted changes",
    );
  }
  return "ready";
}

async function switchBranch(
  args: AttachCheckoutArgs & { branch: CheckoutBranch },
): Promise<void> {
  const { path: cwd, branch, onProgress, signal } = args;
  const options: GitProcessOptions =
    args.shellPath === undefined ? {} : { shellPath: args.shellPath };
  const switchArgs =
    branch.kind === "new"
      ? ["switch", "-C", branch.name, branch.baseBranch]
      : ["switch", branch.name];
  const waitingStartedAt = Date.now();
  emitStep({
    onProgress,
    key: "git-checkout-waiting",
    text: checkoutLabel(branch, "waiting"),
    status: "started",
    startedAt: waitingStartedAt,
  });
  let startedAt = waitingStartedAt;
  let waitingCompleted = false;
  let alreadyOnTarget = false;
  try {
    const locked = await tryWithCheckoutMutationLock(
      cwd,
      async () => {
        throwIfProvisionAborted(signal);
        const lockAcquiredAt = Date.now();
        emitStep({
          onProgress,
          key: "git-checkout-waiting",
          text: checkoutLabel(branch, "ready"),
          status: "completed",
          startedAt: waitingStartedAt,
          metadata: { durationMs: lockAcquiredAt - waitingStartedAt },
        });
        waitingCompleted = true;
        startedAt = lockAcquiredAt;
        if (
          (await assertSwitchable(cwd, branch, options)) === "already-current"
        ) {
          alreadyOnTarget = true;
          return;
        }
        emitStep({
          onProgress,
          key: "git-checkout-started",
          text: checkoutLabel(branch, "doing"),
          status: "started",
          startedAt,
        });
        await runGit(switchArgs, {
          cwd,
          ...(signal !== undefined ? { signal } : {}),
          ...options,
        });
      },
      signal,
      options,
    );
    if (locked === null) {
      throw new WorkspaceError(
        "not_git_repo",
        `Cannot checkout branch on non-git workspace: ${cwd}`,
      );
    }
    waitingCompleted = true;
    emitStep({
      onProgress,
      key: "git-checkout-completed",
      text: alreadyOnTarget
        ? `Already on branch ${branch.name}`
        : checkoutLabel(branch, "done"),
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    const failedAt = Date.now();
    if (!waitingCompleted) {
      emitStep({
        onProgress,
        key: "git-checkout-waiting",
        text: `Failed ${checkoutLabel(branch, "waiting").toLowerCase()}`,
        status: "failed",
        startedAt: waitingStartedAt,
        metadata: { durationMs: failedAt - waitingStartedAt },
      });
    }
    emitStep({
      onProgress,
      key: "git-checkout-failed",
      text: checkoutLabel(branch, "failed"),
      status: "failed",
      startedAt,
      metadata: { durationMs: failedAt - startedAt },
    });
    throw error;
  }
}

export async function inspectCheckout(args: {
  path: string;
  shellPath?: string | undefined;
}): Promise<CheckoutInspection> {
  const options: GitProcessOptions =
    args.shellPath === undefined ? {} : { shellPath: args.shellPath };
  if (!(await pathExists(args.path))) {
    return { isGitRepo: false };
  }
  if (!(await detectGitRepo(args.path, options))) {
    return { isGitRepo: false };
  }
  const [checkout, dirty, operation] = await Promise.all([
    getCheckoutRef(args.path, options),
    hasUncommittedChanges(args.path, options),
    getWorkspaceGitOperation(args.path, options),
  ]);
  return {
    isGitRepo: true,
    checkout,
    hasUncommittedChanges: dirty,
    operation,
  };
}

export async function attachCheckout(
  args: AttachCheckoutArgs,
): Promise<AttachedCheckout> {
  throwIfProvisionAborted(args.signal);
  if (!(await pathExists(args.path))) {
    throw new WorkspaceError(
      "path_not_found",
      `Workspace path does not exist: ${args.path}`,
    );
  }
  const options: GitProcessOptions =
    args.shellPath === undefined ? {} : { shellPath: args.shellPath };
  const isGitRepo = await detectGitRepo(args.path, options);
  if (args.branch !== null) {
    if (!isGitRepo) {
      throw new WorkspaceError(
        "not_git_repo",
        `Cannot checkout branch on non-git workspace: ${args.path}`,
      );
    }
    await switchBranch({ ...args, branch: args.branch });
  }
  if (!isGitRepo) {
    return { path: args.path, branchName: null };
  }
  const ref = await getCheckoutRef(args.path, options);
  return {
    path: args.path,
    branchName:
      ref.kind === "branch" || ref.kind === "unborn" ? ref.branchName : null,
  };
}
