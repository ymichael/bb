import {
  askProviderLaunch,
  attachProviderLaunch,
  cancelProviderLaunch,
  persistPendingProviderRequest,
} from "../environments/provider-orchestration.js";
import { cancelMachineLaunch } from "../machines/provider-orchestration.js";
import {
  getAppSettings,
  getEnvironment,
  getProjectSourceByHost,
  getThread,
  recordEnvironmentCurrentBranch,
  recordEnvironmentProviderProvenance,
} from "@bb/db";
import {
  isLocalPathProjectSource,
  type Environment,
  type ProvisioningTranscriptEntry,
  type Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import {
  getNonDestroyedHostWithStatus,
  requirePublicProject,
} from "../lib/entity-lookup.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import {
  getEnvironmentProvider,
  listEnvironmentProviders,
} from "../plugins/plugin-environment-provider-registry.js";
import { buildSuggestedBranchName } from "./thread-create-helpers.js";
import { appendThreadProvisioningEvent } from "./thread-events.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  completeProviderSelection,
  resolveProducedEnvironmentPlacement,
  validateProviderSelection,
} from "./thread-environment-placement.js";
import {
  forgetActiveThreadProvisionContext,
  listActiveThreadProviderAsks,
  rememberActiveThreadProvisionContext,
} from "./thread-provisioning-active-context.js";
import {
  resolveProviderPendingContext,
  type ThreadProvisionEnvironmentPendingContext,
  type ThreadProvisionProviderAsk,
  type ThreadProvisionProviderPendingContext,
} from "./thread-provisioning-context.js";
import { advanceThreadProvisioning } from "./thread-provisioning.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";
import { toEnvironmentResponse } from "../environments/environment-response.js";
import type { ThreadProvisioningDeps } from "./thread-provisioning-environment.js";
import { askMachineLaunch } from "../machines/provider-orchestration.js";
import { getMachineProvider } from "../plugins/plugin-machine-provider-registry.js";

const PROVIDER_UNAVAILABLE_RETRY_MS = 30_000;

const PROVIDER_REASK_FALLBACK_MS = 30_000;

const PROVIDER_LOG_CHUNK_MAX_TEXT = 16_384;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function reaskLater(
  deps: ThreadProvisioningDeps,
  ask: ThreadProvisionProviderAsk,
  threadId: string,
  at: number,
): NodeJS.Timeout {
  const timer = setTimeout(
    () => {
      if (ask.nextAskTimer !== timer) {
        return;
      }
      if (Date.now() < at) {
        ask.nextAskTimer = reaskLater(deps, ask, threadId, at);
        return;
      }
      ask.nextAskTimer = null;
      void advanceThreadProvisioning(deps, { threadId }).catch((error) => {
        deps.logger.warn(
          { threadId, ...runtimeErrorLogFields(deps.config, error) },
          "Failed to re-ask an environment provider",
        );
      });
    },
    Math.min(Math.max(0, at - Date.now()), MAX_TIMER_DELAY_MS),
  );
  timer.unref?.();
  return timer;
}

export function recheckEnvironmentProviderLaunches(
  deps: ThreadProvisioningDeps,
  pluginId: string,
): void {
  const owned = new Set(
    listEnvironmentProviders()
      .filter((record) => record.pluginId === pluginId)
      .map((record) => record.provider.id),
  );
  for (const { ask, threadId } of listActiveThreadProviderAsks()) {
    if (!owned.has(ask.environmentProviderId)) {
      continue;
    }
    if (ask.nextAskTimer !== null) {
      clearTimeout(ask.nextAskTimer);
    }
    ask.recheckRequested = true;
    ask.nextAskTimer = reaskLater(deps, ask, threadId, Date.now());
  }
}

export function scheduledEnvironmentProviderAskCount(): number {
  return listActiveThreadProviderAsks().filter(
    ({ ask }) => ask.nextAskTimer !== null,
  ).length;
}

interface CancelEnvironmentProviderLaunchArgs {
  environmentProviderId: string;
  threadId: string;
}

async function refreshAttachedEnvironmentBranch(
  deps: ThreadProvisioningDeps,
  args: { environmentId: string; hostId: string; path: string },
): Promise<void> {
  try {
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: args.path,
        remoteRefresh: "background",
      },
    });
    const checkout = inspection.checkout;
    const branchName =
      checkout.kind === "branch" || checkout.kind === "unborn"
        ? checkout.branchName
        : null;
    recordEnvironmentCurrentBranch(deps.db, deps.hub, args.environmentId, {
      branchName,
      defaultBranch: inspection.defaultBranch ?? branchName,
    });
  } catch (error) {
    deps.logger.warn(
      {
        environmentId: args.environmentId,
        hostId: args.hostId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Could not refresh the branch of a reused environment",
    );
  }
}

export function cancelAbandonedProviderLaunches(
  deps: ThreadProvisioningDeps,
  threadId: string,
): void {
  void cancelProviderLaunch(deps, threadId).catch((error) =>
    deps.logger.warn({ threadId, error }, "Environment cancellation failed"),
  );
  void cancelMachineLaunch(deps, threadId).catch((error) =>
    deps.logger.warn({ threadId, error }, "Machine cancellation failed"),
  );
}

export function cancelEnvironmentProviderLaunch(
  deps: ThreadProvisioningDeps,
  args: CancelEnvironmentProviderLaunchArgs,
): void {
  forgetActiveThreadProvisionContext(args.threadId);
  void cancelProviderLaunch(deps, args.threadId).catch((error) => {
    deps.logger.warn(
      { threadId: args.threadId, error },
      "Environment provider cancel failed",
    );
  });
}

function providerFailure(
  environmentProviderId: string,
  pluginId: string | null,
  detail: string,
): ApiError {
  const owner = pluginId === null ? "" : ` (plugin "${pluginId}")`;
  return new ApiError(
    502,
    "environment_provider_failed",
    `The "${environmentProviderId}" environment provider${owner} failed: ${detail}`,
    { details: { environmentProviderId, pluginId } },
  );
}

interface LaunchEntriesArgs {
  ask: ThreadProvisionProviderAsk;
  log: string | undefined;
  now: number;
  step: { text: string; status: "started" | "completed" } | null;
}

function launchEntries(args: LaunchEntriesArgs): ProvisioningTranscriptEntry[] {
  const entries: ProvisioningTranscriptEntry[] = [];
  const { ask } = args;
  if (args.step !== null && ask.lastStep?.text !== args.step.text) {
    if (ask.lastStep !== null) {
      entries.push({
        type: "step",
        key: ask.lastStep.key,
        text: ask.lastStep.text,
        status: "completed",
        startedAt: ask.lastStep.startedAt,
        metadata: { durationMs: args.now - ask.lastStep.startedAt },
      });
    }
    const key = `provider-step-${ask.stepCount}`;
    ask.stepCount += 1;
    ask.lastStep = { key, text: args.step.text, startedAt: args.now };
    entries.push({
      type: "step",
      key,
      text: args.step.text,
      status: args.step.status,
      startedAt: args.now,
    });
  } else if (
    args.step !== null &&
    args.step.status === "completed" &&
    ask.lastStep !== null
  ) {
    entries.push({
      type: "step",
      key: ask.lastStep.key,
      text: ask.lastStep.text,
      status: "completed",
      startedAt: ask.lastStep.startedAt,
      metadata: { durationMs: args.now - ask.lastStep.startedAt },
    });
  }
  if (args.log !== undefined && args.log.length > 0) {
    entries.push({
      type: "output",
      key: `provider-output-${ask.outputCount}`,
      text: args.log.slice(-PROVIDER_LOG_CHUNK_MAX_TEXT),
    });
    ask.outputCount += 1;
  }
  return entries;
}

interface RecordWaitArgs {
  context: ThreadProvisionProviderPendingContext;
  log: string | undefined;
  reason: string;
  sendAt: number | null;
  thread: Thread;
}

function recordWait(deps: ThreadProvisioningDeps, args: RecordWaitArgs): void {
  const ask = args.context.state.providerAsk;
  const entries = launchEntries({
    ask,
    log: args.log,
    now: Date.now(),
    step: { text: args.reason, status: "started" },
  });
  if (entries.length > 0) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.thread.id,
      environmentId: null,
      provisioningId: args.context.state.provisioningId,
      status: "active",
      entries,
    });
  }
  if (ask.nextAskTimer !== null) {
    clearTimeout(ask.nextAskTimer);
  }
  const reaskAt = ask.recheckRequested
    ? Date.now()
    : (args.sendAt ?? Date.now() + PROVIDER_REASK_FALLBACK_MS);
  ask.recheckRequested = false;
  ask.nextAskTimer = reaskLater(deps, ask, args.thread.id, reaskAt);
}

interface ResolveEnvironmentProviderArgs {
  context: ThreadProvisionProviderPendingContext;
  thread: Thread;
}

export type EnvironmentProviderResolution =
  | { kind: "resolved"; context: ThreadProvisionEnvironmentPendingContext }
  | { kind: "waiting" };

export async function resolveEnvironmentProvider(
  deps: ThreadProvisioningDeps,
  args: ResolveEnvironmentProviderArgs,
): Promise<EnvironmentProviderResolution> {
  const context = args.context;
  const intent = context.request.environmentIntent;
  if (intent.type !== "provider" || intent.produced !== null) {
    throw new Error("A provider-pending thread has no provider intent");
  }

  const ask = context.state.providerAsk;
  ask.recheckRequested = false;
  const record = getEnvironmentProvider(intent.environmentProviderId);
  if (record === undefined) {
    persistPendingProviderRequest(deps.db, args.thread.id, context.request);
    recordWait(deps, {
      context,
      log: undefined,
      reason: `Waiting for the "${intent.environmentProviderId}" environment provider, which is not registered by any running plugin`,
      sendAt: Date.now() + PROVIDER_UNAVAILABLE_RETRY_MS,
      thread: args.thread,
    });
    return { kind: "waiting" };
  }

  const thread = getThread(deps.db, args.thread.id);
  if (thread === null || thread.status !== "starting") {
    throw new Error("Thread provisioning context is no longer active");
  }
  const project = requirePublicProject(deps.db, thread.projectId);
  let selection;
  try {
    selection = intent.selectionResolved
      ? { machine: intent.machine, inputs: intent.inputs }
      : await completeProviderSelection(deps, record, thread.projectId, {
          machine: intent.machine,
          inputs: intent.inputs,
        });
  } catch (error) {
    throw providerFailure(
      intent.environmentProviderId,
      record.pluginId,
      error instanceof Error ? error.message : String(error),
    );
  }
  let machineLog = "";
  const machine = selection.machine;
  const host =
    machine.type === "existing"
      ? getNonDestroyedHostWithStatus(deps, machine.hostId)
      : await (async () => {
          const machineRecord = getMachineProvider(machine.machineProviderId);
          if (machineRecord === undefined) {
            throw providerFailure(
              intent.environmentProviderId,
              record.pluginId,
              `needs the "${machine.machineProviderId}" machine provider, which is not registered`,
            );
          }
          const machineDecision = askMachineLaunch(deps, {
            key: thread.id,
            record: machineRecord,
            projectId: thread.projectId,
            inputs: machine.inputs,
          });
          if (machineDecision.action === "reject") {
            throw new ApiError(
              409,
              "machine_provider_rejected",
              machineDecision.message,
            );
          }
          if (machineDecision.action === "wait") {
            recordWait(deps, {
              context,
              log: machineDecision.log,
              reason: machineDecision.reason,
              sendAt: machineDecision.sendAt,
              thread,
            });
            return null;
          }
          machineLog = machineDecision.log;
          return machineDecision.host;
        })();
  if (host === null) {
    if (selection.machine.type === "new") return { kind: "waiting" };
    throw providerFailure(
      intent.environmentProviderId,
      record.pluginId,
      "runs on a machine that no longer exists",
    );
  }
  const requires = record.provider.requires;
  if (requires.gitRemote && project.gitRemoteUrl === null) {
    throw new ApiError(
      409,
      "environment_provider_rejected",
      `${project.name} has no git remote, so the "${intent.environmentProviderId}" environment provider has nothing to clone.`,
      { details: { environmentProviderId: intent.environmentProviderId } },
    );
  }
  const checkout = getProjectSourceByHost(deps.db, thread.projectId, host.id);
  const projectCheckout =
    checkout !== null && isLocalPathProjectSource(checkout)
      ? { path: checkout.path }
      : null;
  if (requires.projectCheckout && projectCheckout === null) {
    throw providerFailure(
      intent.environmentProviderId,
      record.pluginId,
      "works from this project's checkout on the machine, which is no longer configured",
    );
  }
  try {
    await validateProviderSelection(deps, record, {
      hostId: host.id,
      inputs: selection.inputs,
      projectId: thread.projectId,
    });
  } catch (error) {
    throw providerFailure(
      intent.environmentProviderId,
      record.pluginId,
      error instanceof Error ? error.message : String(error),
    );
  }
  const provisionContext = {
    thread: toThreadResponseFromThread(deps, { thread }),
    project,
    host,
    machine: selection.machine,
    projectCheckout,
    gitRemote: requires.gitRemote ? project.gitRemoteUrl : null,
    inputs: selection.inputs,
    suggestedBranchName: buildSuggestedBranchName({
      branchPrefix: getAppSettings(deps.db).managedBranchPrefix,
      title: thread.title ?? thread.titleFallback,
      threadId: thread.id,
    }),
    environment: threadProvisionContextEnvironment(deps, thread.environmentId),
  };
  const decision = askProviderLaunch(
    deps,
    record,
    provisionContext,
    context.request,
  );
  if (decision.action === "reject") {
    throw new ApiError(409, "environment_provider_rejected", decision.message, {
      details: { environmentProviderId: intent.environmentProviderId },
    });
  }
  if (decision.action === "wait") {
    recordWait(deps, {
      context,
      log: machineLog + decision.log,
      reason: decision.reason,
      sendAt: decision.sendAt ?? null,
      thread,
    });
    return { kind: "waiting" };
  }
  if (ask.nextAskTimer !== null) {
    clearTimeout(ask.nextAskTimer);
    ask.nextAskTimer = null;
  }
  const entries = launchEntries({
    ask,
    log: machineLog + decision.log,
    now: Date.now(),
    step:
      ask.lastStep === null
        ? null
        : { text: ask.lastStep.text, status: "completed" },
  });
  if (entries.length > 0) {
    appendThreadProvisioningEvent(deps, {
      threadId: thread.id,
      environmentId: null,
      provisioningId: context.state.provisioningId,
      status: "active",
      entries,
    });
  }
  const placement = await resolveProducedEnvironmentPlacement(deps, {
    environmentProviderId: intent.environmentProviderId,
    inputs: selection.inputs,
    producedEnvironment: decision.environment,
    projectId: thread.projectId,
  });
  if (placement.environmentIntent.type === "reuse") {
    recordEnvironmentProviderProvenance(
      deps.db,
      deps.hub,
      placement.environmentIntent.environmentId,
      {
        environmentProviderId: intent.environmentProviderId,
        instanceKey: decision.instanceKey ?? null,
        selection: {
          machine: selection.machine,
          inputs: selection.inputs,
        },
      },
    );
  }
  if (
    placement.environmentIntent.type === "reuse" &&
    decision.environment.type === "host"
  ) {
    attachProviderLaunch(
      deps.db,
      thread.id,
      placement.environmentIntent.environmentId,
    );
    await refreshAttachedEnvironmentBranch(deps, {
      environmentId: placement.environmentIntent.environmentId,
      hostId: decision.environment.hostId,
      path: decision.environment.path,
    });
  }
  const resolved = resolveProviderPendingContext(context, {
    environmentIntent: placement.environmentIntent,
    producedBy: {
      environmentProviderId: intent.environmentProviderId,
      instanceKey: decision.instanceKey ?? null,
      selection: {
        machine: selection.machine,
        inputs: selection.inputs,
      },
    },
  });
  rememberActiveThreadProvisionContext({
    threadId: thread.id,
    context: resolved,
  });
  return { kind: "resolved", context: resolved };
}

function threadProvisionContextEnvironment(
  deps: Pick<ThreadProvisioningDeps, "db">,
  environmentId: string | null,
): Environment | null {
  if (environmentId === null) {
    return null;
  }
  const environment = getEnvironment(deps.db, environmentId);
  return environment === null ? null : toEnvironmentResponse(environment);
}
