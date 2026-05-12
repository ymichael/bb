import { findEnvironmentByHostPath, getProjectSourceByHost } from "@bb/db";
import type {
  Environment,
  LocalPathProjectSource,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  EnvironmentPromotionActionAvailability,
  EnvironmentPromotionResponse,
  EnvironmentPromotionState,
  EnvironmentPromotionUnavailableReason,
  ProjectSourceWorkspaceStatusResponse,
} from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { LoggedSandboxWorkSessionDeps } from "../../types.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { ensureProjectSourceEnvironment } from "../threads/thread-create.js";
import { requireSourceForHost } from "../threads/thread-create-helpers.js";

interface EnvironmentPromotionArgs {
  environment: Environment;
}

interface ProjectSourceWorkspaceStatusArgs {
  source: LocalPathProjectSource;
}

interface WorkspaceStatusArgs {
  environment: Environment;
  workspacePath: string;
}

interface DemoteEnvironmentArgs {
  environment: Environment;
}

interface PromotionWorkspaceFacts {
  eligibilityUnavailableReason: EnvironmentPromotionUnavailableReason | null;
  environmentStatus: WorkspaceStatus | null;
  primaryStatus: WorkspaceStatus | null;
  source: LocalPathProjectSource | null;
}

interface EnvironmentPromotionEligibilityArgs {
  environment: Environment;
  source: LocalPathProjectSource | null;
}

interface AvailablePromotionWorkspaceEligibility {
  source: LocalPathProjectSource;
  unavailableReason: null;
}

interface UnavailablePromotionWorkspaceEligibility {
  source: LocalPathProjectSource | null;
  unavailableReason: EnvironmentPromotionUnavailableReason;
}

type PromotionWorkspaceEligibility =
  | AvailablePromotionWorkspaceEligibility
  | UnavailablePromotionWorkspaceEligibility;

type EnvironmentPromotionDbDeps = Pick<LoggedSandboxWorkSessionDeps, "db">;

function withReasons(
  unavailableReasons: EnvironmentPromotionUnavailableReason[],
): EnvironmentPromotionActionAvailability {
  return { unavailableReasons };
}

const AVAILABLE: EnvironmentPromotionActionAvailability = {
  unavailableReasons: [],
};

function getLocalPathSourceForEnvironment(
  deps: EnvironmentPromotionDbDeps,
  environment: Environment,
): LocalPathProjectSource | null {
  const source = getProjectSourceByHost(
    deps.db,
    environment.projectId,
    environment.hostId,
  );
  if (!source || source.type !== "local_path") {
    return null;
  }
  return source;
}

function isPrimaryCheckoutEnvironment(
  environment: Environment,
  source: LocalPathProjectSource | null,
): boolean {
  return (
    source !== null &&
    environment.workspaceProvisionType === "unmanaged" &&
    environment.path === source.path
  );
}

function unavailablePromotionWorkspaceEligibility(
  source: LocalPathProjectSource | null,
  unavailableReason: EnvironmentPromotionUnavailableReason,
): UnavailablePromotionWorkspaceEligibility {
  return {
    source,
    unavailableReason,
  };
}

function getPromotionWorkspaceEligibility({
  environment,
  source,
}: EnvironmentPromotionEligibilityArgs): PromotionWorkspaceEligibility {
  if (environment.status !== "ready" || environment.path === null) {
    return unavailablePromotionWorkspaceEligibility(
      source,
      "environment_not_ready",
    );
  }
  if (!environment.isGitRepo) {
    return unavailablePromotionWorkspaceEligibility(
      source,
      "unsupported_workspace",
    );
  }
  if (!environment.branchName) {
    return unavailablePromotionWorkspaceEligibility(
      source,
      "missing_environment_branch",
    );
  }
  if (!source) {
    return unavailablePromotionWorkspaceEligibility(
      source,
      "different_host_or_source",
    );
  }
  if (isPrimaryCheckoutEnvironment(environment, source)) {
    return unavailablePromotionWorkspaceEligibility(
      source,
      "environment_is_primary_checkout",
    );
  }
  if (environment.workspaceProvisionType !== "managed-worktree") {
    return unavailablePromotionWorkspaceEligibility(
      source,
      "unsupported_workspace",
    );
  }
  return {
    source,
    unavailableReason: null,
  };
}

function derivePromotionStateFromFacts(
  environment: Environment,
  facts: PromotionWorkspaceFacts,
): EnvironmentPromotionState {
  const branchName = environment.branchName;
  if (
    !branchName ||
    !facts.primaryStatus ||
    !facts.environmentStatus ||
    facts.eligibilityUnavailableReason !== null
  ) {
    return {
      isPromoted: false,
      branchName,
    };
  }

  return {
    isPromoted:
      facts.primaryStatus.branch.currentBranch === branchName &&
      facts.environmentStatus.branch.currentBranch !== branchName,
    branchName,
  };
}

interface ReadyPromotionStatuses {
  environmentStatus: WorkspaceStatus;
  primaryStatus: WorkspaceStatus;
}

type CommonAvailabilityCheck =
  | { precondition: EnvironmentPromotionUnavailableReason }
  | {
      precondition: null;
      reasons: EnvironmentPromotionUnavailableReason[];
      statuses: ReadyPromotionStatuses;
    };

function checkCommonAvailability(
  facts: PromotionWorkspaceFacts,
): CommonAvailabilityCheck {
  if (facts.eligibilityUnavailableReason) {
    return { precondition: facts.eligibilityUnavailableReason };
  }
  if (!facts.primaryStatus) {
    return { precondition: "primary_checkout_status_unavailable" };
  }
  if (!facts.environmentStatus) {
    return { precondition: "environment_status_unavailable" };
  }
  const reasons: EnvironmentPromotionUnavailableReason[] = [];
  if (facts.primaryStatus.workingTree.hasUncommittedChanges) {
    reasons.push("primary_checkout_dirty");
  }
  if (facts.environmentStatus.workingTree.hasUncommittedChanges) {
    reasons.push("environment_dirty");
  }
  return {
    precondition: null,
    reasons,
    statuses: {
      environmentStatus: facts.environmentStatus,
      primaryStatus: facts.primaryStatus,
    },
  };
}

function buildPromoteAvailability(
  facts: PromotionWorkspaceFacts,
  state: EnvironmentPromotionState,
): EnvironmentPromotionActionAvailability {
  const check = checkCommonAvailability(facts);
  if (check.precondition) {
    return withReasons([check.precondition]);
  }
  const reasons = [...check.reasons];
  if (state.isPromoted) {
    reasons.push("already_promoted");
  } else if (
    check.statuses.environmentStatus.branch.currentBranch !== state.branchName
  ) {
    reasons.push("environment_branch_mismatch");
  }
  return reasons.length === 0 ? AVAILABLE : withReasons(reasons);
}

function buildDemoteAvailability(
  environment: Environment,
  facts: PromotionWorkspaceFacts,
  state: EnvironmentPromotionState,
): EnvironmentPromotionActionAvailability {
  const check = checkCommonAvailability(facts);
  if (check.precondition) {
    return withReasons([check.precondition]);
  }
  const reasons = [...check.reasons];
  if (!environment.defaultBranch) {
    reasons.push("missing_default_branch");
  }
  if (!state.isPromoted) {
    reasons.push("not_promoted");
  }
  return reasons.length === 0 ? AVAILABLE : withReasons(reasons);
}

async function readWorkspaceStatus(
  deps: LoggedSandboxWorkSessionDeps,
  args: WorkspaceStatusArgs,
): Promise<WorkspaceStatus | null> {
  if (!args.environment.isGitRepo || !args.environment.path) {
    return null;
  }
  const result = await queueCommandAndWait(deps, {
    hostId: args.environment.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "workspace.status",
      environmentId: args.environment.id,
      workspaceContext: {
        workspacePath: args.workspacePath,
        workspaceProvisionType: args.environment.workspaceProvisionType,
      },
    },
  });
  return result.workspaceStatus;
}

export async function readEnvironmentWorkspaceStatus(
  deps: LoggedSandboxWorkSessionDeps,
  args: EnvironmentPromotionArgs,
): Promise<WorkspaceStatus | null> {
  if (!args.environment.path) {
    return null;
  }
  return readWorkspaceStatus(deps, {
    environment: args.environment,
    workspacePath: args.environment.path,
  });
}

export async function readProjectSourceWorkspaceStatus(
  deps: LoggedSandboxWorkSessionDeps,
  args: ProjectSourceWorkspaceStatusArgs,
): Promise<ProjectSourceWorkspaceStatusResponse> {
  const environment = await ensureProjectSourceEnvironment(deps, {
    hostId: args.source.hostId,
    path: args.source.path,
    projectId: args.source.projectId,
  });
  const workspace = environment.isGitRepo
    ? await readWorkspaceStatus(deps, {
        environment,
        workspacePath: args.source.path,
      })
    : null;

  return {
    sourceId: args.source.id,
    hostId: args.source.hostId,
    path: args.source.path,
    refreshedAt: Date.now(),
    workspace,
  };
}

async function readExistingProjectSourceWorkspaceStatus(
  deps: LoggedSandboxWorkSessionDeps,
  args: ProjectSourceWorkspaceStatusArgs,
): Promise<WorkspaceStatus | null> {
  const environment = findEnvironmentByHostPath(
    deps.db,
    args.source.hostId,
    args.source.path,
  );
  if (
    !environment ||
    environment.status !== "ready" ||
    !environment.isGitRepo
  ) {
    return null;
  }

  return readWorkspaceStatus(deps, {
    environment,
    workspacePath: args.source.path,
  });
}

async function readPromotionWorkspaceFacts(
  deps: LoggedSandboxWorkSessionDeps,
  environment: Environment,
): Promise<PromotionWorkspaceFacts> {
  const source = getLocalPathSourceForEnvironment(deps, environment);
  const eligibility = getPromotionWorkspaceEligibility({ environment, source });
  if (eligibility.unavailableReason) {
    return {
      eligibilityUnavailableReason: eligibility.unavailableReason,
      environmentStatus: null,
      primaryStatus: null,
      source: eligibility.source,
    };
  }

  const [primaryStatusResponse, environmentStatus] = await Promise.all([
    readProjectSourceWorkspaceStatus(deps, {
      source: eligibility.source,
    }),
    readEnvironmentWorkspaceStatus(deps, {
      environment,
    }),
  ]);
  const primaryStatus = primaryStatusResponse.workspace;
  return {
    eligibilityUnavailableReason: null,
    environmentStatus,
    primaryStatus,
    source: eligibility.source,
  };
}

async function readPromotionWorkspaceFactsFromExistingPrimary(
  deps: LoggedSandboxWorkSessionDeps,
  environment: Environment,
): Promise<PromotionWorkspaceFacts> {
  const source = getLocalPathSourceForEnvironment(deps, environment);
  const eligibility = getPromotionWorkspaceEligibility({ environment, source });
  if (eligibility.unavailableReason) {
    return {
      eligibilityUnavailableReason: eligibility.unavailableReason,
      environmentStatus: null,
      primaryStatus: null,
      source: eligibility.source,
    };
  }

  const primaryStatus = await readExistingProjectSourceWorkspaceStatus(deps, {
    source: eligibility.source,
  });
  const environmentStatus = primaryStatus
    ? await readEnvironmentWorkspaceStatus(deps, { environment })
    : null;
  return {
    eligibilityUnavailableReason: null,
    environmentStatus,
    primaryStatus,
    source: eligibility.source,
  };
}

export async function readEnvironmentPromotionResponse(
  deps: LoggedSandboxWorkSessionDeps,
  args: EnvironmentPromotionArgs,
): Promise<EnvironmentPromotionResponse> {
  const facts = await readPromotionWorkspaceFacts(deps, args.environment);
  const state = derivePromotionStateFromFacts(args.environment, facts);
  return {
    state,
    actions: {
      promote: buildPromoteAvailability(facts, state),
      demote: buildDemoteAvailability(args.environment, facts, state),
    },
  };
}

export async function deriveEnvironmentPromotionState(
  deps: LoggedSandboxWorkSessionDeps,
  args: EnvironmentPromotionArgs,
): Promise<EnvironmentPromotionState> {
  const facts = await readPromotionWorkspaceFacts(deps, args.environment);
  return derivePromotionStateFromFacts(args.environment, facts);
}

export async function queueEnvironmentDemote(
  deps: LoggedSandboxWorkSessionDeps,
  args: DemoteEnvironmentArgs,
): Promise<void> {
  if (args.environment.status !== "ready" || !args.environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }
  const source = requireSourceForHost(
    deps,
    args.environment.projectId,
    args.environment.hostId,
  );
  if (!args.environment.branchName || !args.environment.defaultBranch) {
    throw new ApiError(409, "invalid_request", "Environment cannot be demoted");
  }
  await queueCommandAndWait(deps, {
    hostId: args.environment.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "workspace.demote",
      environmentId: args.environment.id,
      workspaceContext: {
        workspacePath: args.environment.path,
        workspaceProvisionType: args.environment.workspaceProvisionType,
      },
      primaryPath: source.path,
      defaultBranch: args.environment.defaultBranch,
      envBranch: args.environment.branchName,
    },
  });
}

export async function demoteEnvironmentIfPromoted(
  deps: LoggedSandboxWorkSessionDeps,
  args: DemoteEnvironmentArgs,
): Promise<void> {
  const facts = await readPromotionWorkspaceFactsFromExistingPrimary(
    deps,
    args.environment,
  );
  const state = derivePromotionStateFromFacts(args.environment, facts);
  if (!state.isPromoted) {
    return;
  }

  await queueEnvironmentDemote(deps, args);
}
