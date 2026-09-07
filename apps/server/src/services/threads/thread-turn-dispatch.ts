import type {
  Environment,
  PromptInput,
  ResolvedThreadExecutionOptions,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
  ThreadTurnInitiator,
} from "@bb/domain";
import { createThreadProvisioningId } from "@bb/db";
import type { DbTransaction } from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  dispatchManagedEnvironmentReprovision,
  hasActiveManagedEnvironmentProvision,
  MANAGED_REPROVISION_IN_PROGRESS,
} from "../environments/environment-provisioning-internal.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  goneThreadEnvironmentDetails,
  throwEnvironmentNotReady,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import {
  appendThreadProvisioningEvent,
  getLastProviderThreadId,
} from "./thread-events.js";
import { requestThreadReprovision } from "./thread-provisioning.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { applyLoggedEnvironmentLifecycleEvent } from "../environments/lifecycle-outcome.js";

export interface ReadyThreadEnvironment extends Environment {
  path: string;
  status: "ready";
}

interface DispatchTurnDuringReprovisionArgs {
  beforeRequestAppendInTransaction?: (args: { tx: DbTransaction }) => void;
  deps: LoggedPendingInteractionWorkSessionDeps;
  environment: Environment;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  thread: Thread;
}

function reprovisionStartedText(
  workspaceProvisionType: Environment["workspaceProvisionType"],
): string {
  switch (workspaceProvisionType) {
    case "managed-worktree":
      return "Restoring worktree";
    case "personal":
      return "Restoring personal workspace";
    case "unmanaged":
      return "Restoring environment";
  }
}

function canRecoverPreStartErroredThread(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  thread: Thread,
): boolean {
  return (
    thread.status === "error" &&
    getLastProviderThreadId(deps, thread.id) === null
  );
}

export function requireReadyThreadEnvironment(
  environment: Environment,
): ReadyThreadEnvironment {
  if (environment.status !== "ready" || !environment.path) {
    throwEnvironmentNotReady(environment);
  }

  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

export async function dispatchTurnDuringReprovision(
  args: DispatchTurnDuringReprovisionArgs,
): Promise<boolean> {
  if (args.environment.status === "ready" && args.environment.path) {
    return false;
  }

  if (args.environment.status === "retiring") {
    applyLoggedEnvironmentLifecycleEvent(args.deps, {
      environmentId: args.environment.id,
      event: { type: "retire.cancelled" },
    });
    return false;
  }

  const goneDetails = goneThreadEnvironmentDetails(args.environment);
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }

  if (!args.environment.managed || args.environment.status === "provisioning") {
    throwEnvironmentNotReady(args.environment);
  }
  if (
    hasActiveManagedEnvironmentProvision(args.deps, {
      environmentId: args.environment.id,
    })
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment is already provisioning",
    );
  }
  await ensureHostSessionReadyForWork(args.deps, {
    hostId: args.environment.hostId,
  });

  if (
    args.thread.status === "idle" ||
    canRecoverPreStartErroredThread(args.deps, args.thread)
  ) {
    applyLoggedThreadLifecycleEvent(args.deps, {
      event: { type: "run.preparing" },
      threadId: args.thread.id,
    });
  }
  const provisioningId = createThreadProvisioningId();
  const provisionEventSequence = appendThreadProvisioningEvent(args.deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    provisioningId,
    status: "active",
    entries: [
      {
        type: "step",
        key: "workspace-restore-started",
        text: reprovisionStartedText(args.environment.workspaceProvisionType),
        status: "started",
      },
    ],
  });

  const reprovisionResult = await dispatchManagedEnvironmentReprovision(
    args.deps,
    {
      beforeProvisionCommandStart: () => {
        requestThreadReprovision(args.deps, {
          beforeRequestAppendInTransaction:
            args.beforeRequestAppendInTransaction,
          thread: args.thread,
          environment: args.environment,
          provisionEventSequence,
          input: args.input,
          inputGroups: args.inputGroups,
          execution: args.execution,
          initiator: args.initiator,
          provisioningId,
          senderThreadId: args.senderThreadId,
          systemMessageKind: args.systemMessageKind,
          systemMessageSubject: args.systemMessageSubject,
        });
        // The turn above is queued, not sent: it replays when the workspace is
        // ready, driven by the provisioning machinery that owns that ordering.
        // It deliberately does NOT become a queued row — the queue carries
        // dispatches core will re-ATTEMPT, and this one is already committed
        // to a specific replay. Messages that arrive DURING the reprovision do
        // queue, on `waitingOn: provisioning`, and the workspace-ready drain
        // releases them.
      },
      environment: args.environment,
      projectId: args.thread.projectId,
      provisionEventSequence,
      provisioningId,
      threadId: args.thread.id,
    },
  );
  if (reprovisionResult === MANAGED_REPROVISION_IN_PROGRESS) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment is already provisioning",
    );
  }
  return true;
}
