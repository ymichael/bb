import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
  ThreadTurnInitiator,
} from "@bb/domain";
import type { DbTransaction, EnvironmentRow } from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  goneThreadEnvironmentDetails,
  throwEnvironmentNotReady,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import {
  requestThreadTargetReprovision,
  scheduleThreadProvisioningAdvance,
} from "./thread-provisioning.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";

export interface ReadyThreadEnvironment extends EnvironmentRow {
  path: string;
  status: "ready";
}

interface DispatchTurnDuringReprovisionArgs {
  beforeRequestAppendInTransaction?: (args: { tx: DbTransaction }) => void;
  deps: LoggedPendingInteractionWorkSessionDeps;
  environment: EnvironmentRow;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  thread: Thread;
}

export function requireReadyThreadEnvironment(
  environment: EnvironmentRow,
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

  const environmentProviderId = args.environment.environmentProviderId;
  const environmentProviderSelection =
    args.environment.environmentProviderSelection;
  if (
    environmentProviderId !== null &&
    environmentProviderSelection !== null &&
    args.environment.status !== "provisioning"
  ) {
    const prepared = applyLoggedThreadLifecycleEvent(args.deps, {
      event: { type: "run.preparing" },
      threadId: args.thread.id,
    });
    if (!prepared.applied) {
      throwEnvironmentNotReady(args.environment);
    }
    const context = requestThreadTargetReprovision(args.deps, {
      beforeRequestAppendInTransaction: args.beforeRequestAppendInTransaction,
      environment: args.environment,
      execution: args.execution,
      initiator: args.initiator,
      input: args.input,
      inputGroups: args.inputGroups,
      senderThreadId: args.senderThreadId,
      systemMessageKind: args.systemMessageKind,
      systemMessageSubject: args.systemMessageSubject,
      provider: {
        environmentProviderId,
        selection: environmentProviderSelection,
      },
      thread: args.thread,
    });
    scheduleThreadProvisioningAdvance(args.deps, context, args.thread.id);
    return true;
  }

  const goneDetails = goneThreadEnvironmentDetails(args.environment);
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }

  throwEnvironmentNotReady(args.environment);
}
