import type {
  HostDaemonCommand,
  HostDaemonSettledCommandType,
} from "@bb/host-daemon-contract";
import {
  emptyCommandResultSideEffects,
  type CommandResultReportForType,
  type CommandResultSettlementDeps,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
} from "./command-result-side-effects.js";
import { settleEnvironmentDestroyCommandResult } from "../services/environments/environment-cleanup-internal.js";
import {
  settleEnvironmentProvisionCancelCommandResult,
  settleEnvironmentProvisionCommandResult,
} from "../services/environments/environment-provisioning-internal.js";
import {
  settleThreadPlanCancelCommandResult,
  settleThreadStartCommandResult,
  settleThreadStopCommandResult,
  settleTurnSubmitCommandResult,
} from "../services/threads/thread-lifecycle.js";
import { notifyWorkspaceMutationResult } from "./environment-changes.js";

type ParsedCommandType = HostDaemonSettledCommandType;
type ParsedCommandForType<TType extends ParsedCommandType> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

interface ApplyCommandResultSideEffectsArgs<TType extends ParsedCommandType> {
  command: ParsedCommandForType<TType>;
  deps: CommandResultSettlementDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: CommandResultReportForType<TType>;
}

type CommandResultSideEffectHandlers = {
  [TType in ParsedCommandType]?: (
    args: ApplyCommandResultSideEffectsArgs<TType>,
  ) => CommandResultSideEffectsResult | void;
};

const commandResultSideEffectHandlers: CommandResultSideEffectHandlers = {
  "environment.destroy": settleEnvironmentDestroyCommandResult,
  "environment.provision": settleEnvironmentProvisionCommandResult,
  "environment.provision.cancel": settleEnvironmentProvisionCancelCommandResult,
  "interactive.resolve": ({ deps, command, report }) => {
    deps.pendingInteractions.settleInteractiveResolveCommandResultInTransaction(
      {
        command,
        deps,
        report,
      },
    );
  },
  "thread.start": settleThreadStartCommandResult,
  "thread.stop": settleThreadStopCommandResult,
  "thread.plan.cancel": settleThreadPlanCancelCommandResult,
  "turn.submit": settleTurnSubmitCommandResult,
  "workspace.commit": ({ deps, command, report }) => {
    notifyWorkspaceMutationResult(deps, {
      environmentId: command.environmentId,
      ok: report.ok,
    });
  },
  "workspace.pull_request_action": ({ deps, command, report }) => {
    notifyWorkspaceMutationResult(deps, {
      environmentId: command.environmentId,
      ok: report.ok,
    });
  },
} satisfies CommandResultSideEffectHandlers;

export function handleLiveCommandResultSideEffects<
  TType extends ParsedCommandType,
>(
  deps: CommandResultSettlementDeps,
  args: {
    command: ParsedCommandForType<TType>;
    execution: HostDaemonCommandExecutionRecord;
    report: CommandResultReportForType<TType>;
  },
): CommandResultSideEffectsResult {
  const handler = commandResultSideEffectHandlers[args.command.type];
  if (!handler) {
    return emptyCommandResultSideEffects();
  }

  return (
    handler({
      deps,
      report: args.report,
      command: args.command,
      execution: args.execution,
    }) ?? emptyCommandResultSideEffects()
  );
}
