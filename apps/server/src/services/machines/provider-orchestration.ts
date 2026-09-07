import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  deleteProjectSource,
  getHost,
  getMachineLaunch,
  listEnvironments,
  listMachineLaunchesByPhase,
  listProjectSourcesByHost,
  listProviderMachines,
  machineHasLiveThreads,
  machineHasOpenTerminal,
  machineIdleSince,
  updateHost,
  updateMachineLaunchAttempt,
  upsertMachineLaunch,
  type MachineLaunchRow,
} from "@bb/db";
import { jsonValueSchema, type Host, type JsonValue } from "@bb/domain";
import type {
  PluginMachineProviderCreateResult,
  PluginMachineProviderProgress,
} from "@get-bb/plugin-sdk/machine-provider";
import { summarizeStandardIssues } from "@get-bb/plugin-sdk/internal/host-policy";
import { ApiError } from "../../errors.js";
import type { ThreadProvisioningDeps } from "../threads/thread-provisioning-environment.js";
import { decideWithinBox } from "../threads/dispatch-hooks.js";
import {
  getMachineProvider,
  invokeMachineProvider,
  listMachineProviders,
  machineProviderDecisionTimeoutMs,
  type PluginMachineProviderRecord,
} from "../plugins/plugin-machine-provider-registry.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import {
  requestEnvironmentRemoval,
  sweepProviderEnvironment,
} from "../environments/provider-orchestration.js";

type Deps = ThreadProvisioningDeps;
type MachineLifecycleDeps = Pick<Deps, "db" | "hub" | "logger">;

interface ActiveOperation {
  controller: AbortController;
  done: Promise<void>;
}

const TRANSIENT_RETRY_MS = 30_000;
const TRANSIENT_RETRY_LIMIT = 3;
const resourceSchema = jsonValueSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value)) <= 16_384,
  "Resource exceeds 16 KiB",
);
const createResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("created"),
    hostId: z.string().min(1),
    resource: resourceSchema,
  }),
  z.object({
    status: z.literal("failed"),
    failure: z.enum(["terminal", "transient"]),
    message: z.string().min(1),
  }),
]);
const resourceResultSchema = z.object({ resource: resourceSchema }).strict();
const removeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("removed") }).strict(),
  z
    .object({ status: z.literal("failed"), message: z.string().min(1) })
    .strict(),
]);
const validateDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }).strict(),
  z
    .object({
      action: z.literal("refuse"),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);

const createOperations = new WeakMap<object, Map<string, ActiveOperation>>();
const cancelOperations = new WeakMap<object, Map<string, ActiveOperation>>();
const suspendOperations = new WeakMap<object, Map<string, ActiveOperation>>();
const resumeOperations = new WeakMap<object, Map<string, ActiveOperation>>();
const removeOperations = new WeakMap<object, Map<string, ActiveOperation>>();

function operations(
  registry: WeakMap<object, Map<string, ActiveOperation>>,
  db: Deps["db"],
): Map<string, ActiveOperation> {
  let map = registry.get(db);
  if (map === undefined) {
    map = new Map();
    registry.set(db, map);
  }
  return map;
}

function runTrackedOperation(args: {
  map: Map<string, ActiveOperation>;
  key: string;
  run: (signal: AbortSignal) => Promise<void>;
}): ActiveOperation {
  const existing = args.map.get(args.key);
  if (existing !== undefined) return existing;
  const controller = new AbortController();
  const operation: ActiveOperation = {
    controller,
    done: Promise.resolve(),
  };
  operation.done = args.run(controller.signal).finally(() => {
    if (args.map.get(args.key) === operation) args.map.delete(args.key);
  });
  args.map.set(args.key, operation);
  return operation;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deleteMachineProjectSources(
  deps: MachineLifecycleDeps,
  hostId: string,
): void {
  for (const source of listProjectSourcesByHost(deps.db, hostId)) {
    deleteProjectSource(deps.db, deps.hub, source.id);
  }
}

function mutateLaunch(
  deps: Deps,
  launch: MachineLaunchRow,
  phases: MachineLaunchRow["phase"][],
  change: (row: MachineLaunchRow) => void,
): boolean {
  const row = getMachineLaunch(deps.db, launch.key);
  if (
    row === null ||
    row.attempt !== launch.attempt ||
    !phases.includes(row.phase)
  ) {
    return false;
  }
  change(row);
  return updateMachineLaunchAttempt(deps.db, row);
}

function launchReporter(
  deps: Deps,
  launch: MachineLaunchRow,
): PluginMachineProviderProgress {
  const update = (change: (row: MachineLaunchRow) => void): void => {
    mutateLaunch(deps, launch, ["creating"], change);
  };
  return {
    step: (text) =>
      update((row) => {
        row.stepText = text.slice(0, 200);
      }),
    log: (text) =>
      update((row) => {
        row.pendingLog = (row.pendingLog + text).slice(-16_384);
      }),
  };
}

function lifecycleReporter(
  deps: MachineLifecycleDeps,
  hostId: string,
): PluginMachineProviderProgress {
  return {
    step: (text) => {
      const current = getHost(deps.db, hostId);
      if (current === null || current.destroyedAt !== null) return;
      updateHost(deps.db, deps.hub, hostId, {
        teardownMessage: text.slice(0, 500),
      });
      deps.hub.notifyHost(hostId, ["host-connected"]);
    },
    log: (text) => {
      deps.logger.info({ hostId }, text.slice(-16_384));
    },
  };
}

async function invokeCreate(
  record: PluginMachineProviderRecord,
  launch: MachineLaunchRow,
  deps: Deps,
  signal: AbortSignal,
): Promise<PluginMachineProviderCreateResult> {
  const project =
    launch.projectId === null
      ? null
      : requirePublicProject(deps.db, launch.projectId);
  const invocation = await invokeMachineProvider(record, "machine create", () =>
    record.provider.create({
      ...(project === null
        ? { project: null, gitRemote: null }
        : {
            project,
            gitRemote: record.provider.requires.gitRemote
              ? project.gitRemoteUrl
              : null,
          }),
      inputs: launch.inputs,
      key: launch.key,
      attempt: launch.attempt,
      report: launchReporter(deps, launch),
      signal,
    }),
  );
  if (!invocation.ok) throw new Error(invocation.error);
  return createResultSchema.parse(invocation.value);
}

async function removeResource(
  deps: Deps,
  record: PluginMachineProviderRecord,
  args: { hostId: string; resource: JsonValue; signal: AbortSignal },
): Promise<void> {
  const invocation = await invokeMachineProvider(record, "machine remove", () =>
    record.provider.remove({
      hostId: args.hostId,
      resource: args.resource,
      report: lifecycleReporter(deps, args.hostId),
      signal: args.signal,
    }),
  );
  if (!invocation.ok) throw new Error(invocation.error);
  const result = removeResultSchema.parse(invocation.value);
  if (result.status === "failed") throw new Error(result.message);
}

async function runCreate(
  deps: Deps,
  record: PluginMachineProviderRecord,
  launch: MachineLaunchRow,
  signal: AbortSignal,
): Promise<void> {
  try {
    const result = await invokeCreate(record, launch, deps, signal);
    if (result.status === "failed") {
      mutateLaunch(deps, launch, ["creating"], (row) => {
        row.phase = "failed";
        row.failure = result.failure;
        row.message = result.message;
        row.failedAt = Date.now();
        if (result.failure === "transient") row.transientFailures += 1;
      });
      return;
    }
    const current = getMachineLaunch(deps.db, launch.key);
    if (
      current === null ||
      current.attempt !== launch.attempt ||
      current.phase !== "creating"
    ) {
      await removeResource(deps, record, { ...result, signal });
      if (current?.phase === "cancelled") {
        updateMachineLaunchAttempt(deps.db, {
          ...current,
          cancelPending: false,
        });
      }
      return;
    }
    const host = getHost(deps.db, result.hostId);
    if (host === null || host.destroyedAt !== null) {
      await removeResource(deps, record, { ...result, signal });
      throw new Error(
        `Machine provider "${record.provider.id}" returned host "${result.hostId}" without enrolling it`,
      );
    }
    if (
      host.machineProviderId !== null &&
      host.machineProviderId !== record.provider.id
    ) {
      await removeResource(deps, record, { ...result, signal });
      throw new Error(
        `Machine provider "${record.provider.id}" returned host "${result.hostId}", which belongs to "${host.machineProviderId}"`,
      );
    }
    updateHost(deps.db, deps.hub, result.hostId, {
      machineProviderId: record.provider.id,
      machineProviderSelection: { inputs: launch.inputs },
      phase: "active",
      resource: result.resource,
      retireAt: null,
      suspendedAt: null,
      teardownAttempt: 0,
      teardownMessage: null,
      teardownStatus: null,
    });
    deps.hub.notifyHost(result.hostId, ["host-connected"]);
    mutateLaunch(deps, launch, ["creating"], (row) => {
      row.phase = "ready";
      row.hostId = result.hostId;
      row.resource = result.resource;
      row.message = null;
      row.failure = null;
      row.failedAt = null;
    });
  } catch (error) {
    const current = getMachineLaunch(deps.db, launch.key);
    if (signal.aborted && current?.phase === "cancelled") return;
    mutateLaunch(deps, launch, ["creating"], (row) => {
      row.phase = "failed";
      row.failure = "terminal";
      row.message = `The "${record.provider.id}" machine provider (plugin "${record.pluginId}") failed: ${errorMessage(error)}`;
      row.failedAt = Date.now();
    });
  }
}

function startCreate(
  deps: Deps,
  record: PluginMachineProviderRecord,
  launch: MachineLaunchRow,
): ActiveOperation {
  return runTrackedOperation({
    map: operations(createOperations, deps.db),
    key: `${launch.key}:${launch.attempt}`,
    run: (signal) => runCreate(deps, record, launch, signal),
  });
}

export async function parseMachineProviderInputs(
  record: PluginMachineProviderRecord,
  inputs: JsonValue | null,
): Promise<JsonValue | null> {
  const schema = record.provider.inputs;
  if (schema === null) {
    if (inputs !== null) {
      throw new ApiError(
        400,
        "invalid_request",
        `The "${record.provider.id}" machine provider takes no inputs, but the request carried some`,
      );
    }
    return null;
  }
  if (inputs === null) {
    throw new ApiError(
      400,
      "invalid_request",
      `The "${record.provider.id}" machine provider needs inputs, and the request carried none`,
    );
  }
  const invocation = await invokeMachineProvider(
    record,
    `"${record.provider.id}" machine provider inputs`,
    async () => schema["~standard"].validate(inputs),
  );
  if (!invocation.ok) {
    throw new ApiError(
      502,
      "machine_provider_failed",
      `The "${record.provider.id}" machine provider (plugin "${record.pluginId}") failed to validate its inputs: ${invocation.error}`,
    );
  }
  if (invocation.value.issues !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      `The "${record.provider.id}" machine provider refused the inputs: ${summarizeStandardIssues(invocation.value.issues)}`,
    );
  }
  const parsed = jsonValueSchema.safeParse(invocation.value.value);
  if (!parsed.success) {
    throw new ApiError(
      502,
      "machine_provider_failed",
      `The "${record.provider.id}" machine provider parsed its inputs into a value that is not JSON`,
    );
  }
  return parsed.data;
}

export async function prepareMachineProviderSelection(
  deps: Deps,
  args: {
    machineProviderId: string;
    projectId: string | null;
    inputs: JsonValue | null;
  },
): Promise<{ record: PluginMachineProviderRecord; inputs: JsonValue | null }> {
  const record = getMachineProvider(args.machineProviderId);
  if (record === undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      `Unknown machine provider "${args.machineProviderId}"`,
    );
  }
  const project =
    args.projectId === null
      ? null
      : requirePublicProject(deps.db, args.projectId);
  if (
    record.provider.requires.gitRemote &&
    project !== null &&
    project.gitRemoteUrl === null
  ) {
    throw new ApiError(
      409,
      "machine_provider_rejected",
      `${project.name} has no git remote, so the "${record.provider.id}" machine provider has nothing to clone.`,
    );
  }
  const inputs = await parseMachineProviderInputs(record, args.inputs);
  if (record.provider.validate !== null) {
    const invocation = await invokeMachineProvider(
      record,
      `"${record.provider.id}" machine provider validate`,
      () =>
        decideWithinBox(
          () =>
            Promise.resolve(
              record.provider.validate?.({
                ...(project === null
                  ? { project: null, gitRemote: null }
                  : {
                      project,
                      gitRemote: record.provider.requires.gitRemote
                        ? project.gitRemoteUrl
                        : null,
                    }),
                inputs,
              }),
            ),
          machineProviderDecisionTimeoutMs(),
        ),
    );
    if (!invocation.ok) {
      throw new ApiError(
        502,
        "machine_provider_failed",
        `The "${record.provider.id}" machine provider failed to validate the request: ${invocation.error}`,
      );
    }
    if (!invocation.value.ok) {
      throw new ApiError(
        502,
        "machine_provider_failed",
        `The "${record.provider.id}" machine provider failed to validate the request: ${invocation.value.error}`,
      );
    }
    const decision = validateDecisionSchema.safeParse(invocation.value.value);
    if (!decision.success) {
      throw new ApiError(
        502,
        "machine_provider_failed",
        `The "${record.provider.id}" machine provider returned an invalid validate decision`,
      );
    }
    if (decision.data.action === "refuse") {
      throw new ApiError(
        409,
        "machine_provider_rejected",
        decision.data.message,
      );
    }
  }
  return { record, inputs };
}

export type MachineLaunchDecision =
  | { action: "wait"; reason: string; sendAt: number; log: string }
  | { action: "reject"; message: string }
  | { action: "ready"; host: Host; log: string };

export function askMachineLaunch(
  deps: Deps,
  args: {
    key: string;
    record: PluginMachineProviderRecord;
    projectId: string | null;
    inputs: JsonValue | null;
  },
): MachineLaunchDecision {
  const now = Date.now();
  let row = getMachineLaunch(deps.db, args.key);
  const changed =
    row !== null &&
    (row.providerId !== args.record.provider.id ||
      row.projectId !== args.projectId ||
      JSON.stringify(row.inputs) !== JSON.stringify(args.inputs));
  if (changed) {
    throw new ApiError(
      409,
      "machine_launch_key_conflict",
      `Machine launch key "${args.key}" is already in use`,
    );
  }
  let readyHostIsGone = false;
  if (row?.phase === "ready") {
    const host = row.hostId === null ? null : getHost(deps.db, row.hostId);
    if (host !== null && host.destroyedAt === null) {
      return {
        action: "ready",
        host: machineHostResponse(host, deps),
        log: takeLaunchLog(deps, row),
      };
    }
    readyHostIsGone = true;
  }
  if (row?.phase === "failed") {
    if (
      row.failure === "terminal" ||
      row.transientFailures > TRANSIENT_RETRY_LIMIT
    ) {
      return {
        action: "reject",
        message: row.message ?? "Machine creation failed",
      };
    }
    const retryAt = (row.failedAt ?? now) + TRANSIENT_RETRY_MS;
    if (now < retryAt) {
      return {
        action: "wait",
        reason: `${row.message ?? "Machine creation failed"}; retrying`,
        sendAt: retryAt,
        log: takeLaunchLog(deps, row),
      };
    }
  }
  if (row === null || row.phase === "failed" || readyHostIsGone) {
    const attempt = (row?.attempt ?? 0) + 1;
    row = {
      key: args.key,
      providerId: args.record.provider.id,
      projectId: args.projectId,
      inputs: args.inputs,
      attempt,
      phase: "creating",
      startedAt: now,
      failedAt: null,
      failure: null,
      message: null,
      transientFailures: row?.transientFailures ?? 0,
      hostId: null,
      resource: null,
      stepText: `Creating ${args.record.provider.displayName}…`,
      pendingLog: "",
      cancelPending: false,
    };
    upsertMachineLaunch(deps.db, row);
    startCreate(deps, args.record, row);
  } else if (row.phase === "creating") {
    startCreate(deps, args.record, row);
  } else if (row.phase === "cancelled") {
    return { action: "reject", message: "Machine creation was cancelled" };
  }
  return {
    action: "wait",
    reason: row.stepText,
    sendAt: now + 1_000,
    log: takeLaunchLog(deps, row),
  };
}

function takeLaunchLog(deps: Deps, row: MachineLaunchRow): string {
  const log = row.pendingLog;
  if (log.length > 0) {
    updateMachineLaunchAttempt(deps.db, { ...row, pendingLog: "" });
  }
  return log;
}

function machineHostResponse(
  row: NonNullable<ReturnType<typeof getHost>>,
  deps: Deps,
): Host {
  return {
    id: row.id,
    name: row.name,
    status: deps.hub.hasDaemonForHost(row.id) ? "connected" : "disconnected",
    machineProviderId: row.machineProviderId,
    machineProviderSelection: row.machineProviderSelection,
    lifecycle: {
      phase: row.phase === "suspending" ? "active" : row.phase,
      suspendedAt: row.suspendedAt,
      retireAt: row.retireAt,
      progress: row.teardownStatus === null ? row.teardownMessage : null,
      teardown:
        row.teardownStatus === null
          ? null
          : {
              status: row.teardownStatus,
              attempt: row.teardownAttempt,
              ...(row.teardownMessage === null
                ? {}
                : { message: row.teardownMessage }),
            },
    },
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function cancelMachineLaunch(
  deps: Deps,
  key: string,
): Promise<void> {
  let row = getMachineLaunch(deps.db, key);
  if (row === null || row.phase === "ready") return;
  if (row.phase !== "cancelled") {
    row = { ...row, phase: "cancelled", cancelPending: true };
    updateMachineLaunchAttempt(deps.db, row);
  }
  const create = operations(createOperations, deps.db).get(
    `${row.key}:${row.attempt}`,
  );
  if (create !== undefined) {
    create.controller.abort();
    await create.done;
  }
  row = getMachineLaunch(deps.db, key);
  if (row === null || !row.cancelPending) return;
  const record = getMachineProvider(row.providerId);
  if (record === undefined) return;
  const operation = runTrackedOperation({
    map: operations(cancelOperations, deps.db),
    key,
    run: async (signal) => {
      const current = getMachineLaunch(deps.db, key);
      if (current === null || !current.cancelPending) return;
      let removedHostId: string | null = null;
      if (current.hostId !== null && current.resource !== null) {
        await removeResource(deps, record, {
          hostId: current.hostId,
          resource: current.resource,
          signal,
        });
        removedHostId = current.hostId;
      } else {
        const recovered = await invokeCreate(record, current, deps, signal);
        if (recovered.status === "failed") {
          throw new Error(recovered.message);
        }
        await removeResource(deps, record, { ...recovered, signal });
        removedHostId = recovered.hostId;
      }
      if (removedHostId !== null) {
        deleteMachineProjectSources(deps, removedHostId);
        await deps.machineAuth.revokeHostAuthKeys({ hostId: removedHostId });
        const host = getHost(deps.db, removedHostId);
        if (host !== null && host.destroyedAt === null) {
          updateHost(deps.db, deps.hub, removedHostId, {
            destroyedAt: Date.now(),
            phase: "destroyed",
            resource: null,
            retireAt: null,
            suspendedAt: null,
            teardownStatus: "removed",
            teardownMessage: null,
          });
          deps.hub.notifyHost(removedHostId, ["host-disconnected"]);
        }
      }
      updateMachineLaunchAttempt(deps.db, {
        ...current,
        cancelPending: false,
        hostId: null,
        resource: null,
      });
    },
  });
  await operation.done;
}

export async function createMachine(
  deps: Deps,
  args: {
    key?: string;
    machineProviderId: string;
    projectId: string | null;
    inputs: JsonValue | null;
    signal?: AbortSignal;
  },
): Promise<Host> {
  const key = args.key ?? `machine-${randomUUID()}`;
  const prepared = await prepareMachineProviderSelection(deps, args);
  for (;;) {
    if (args.signal?.aborted) {
      await cancelMachineLaunch(deps, key);
      throw new ApiError(
        409,
        "request_cancelled",
        "Machine creation cancelled",
      );
    }
    const decision = askMachineLaunch(deps, {
      key,
      record: prepared.record,
      projectId: args.projectId,
      inputs: prepared.inputs,
    });
    if (decision.action === "ready") return decision.host;
    if (decision.action === "reject") {
      throw new ApiError(409, "machine_provider_rejected", decision.message);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        args.signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(
        done,
        Math.max(0, Math.min(250, decision.sendAt - Date.now())),
      );
      args.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

async function suspendMachine(deps: Deps, hostId: string): Promise<void> {
  const removing = operations(removeOperations, deps.db).get(hostId);
  if (removing !== undefined) {
    await removing.done.catch(() => {});
    return;
  }
  const resuming = operations(resumeOperations, deps.db).get(hostId);
  if (resuming !== undefined) {
    await resuming.done.catch(() => {});
  }
  const suspending = operations(suspendOperations, deps.db).get(hostId);
  if (suspending !== undefined) {
    await suspending.done;
    return;
  }
  const row = getHost(deps.db, hostId);
  if (
    row === null ||
    row.machineProviderId === null ||
    row.phase !== "active"
  ) {
    return;
  }
  const record = getMachineProvider(row.machineProviderId);
  if (record === undefined || record.provider.suspend === null) return;
  if (row.resource === null) {
    throw new Error(`Machine "${hostId}" has no provider resource`);
  }
  const suspend = record.provider.suspend;
  const resource = row.resource;
  const operation = runTrackedOperation({
    map: operations(suspendOperations, deps.db),
    key: hostId,
    run: async (signal) => {
      updateHost(deps.db, deps.hub, hostId, {
        phase: "suspending",
        teardownMessage: null,
        teardownStatus: null,
      });
      const invocation = await invokeMachineProvider(
        record,
        "machine suspend",
        () =>
          suspend({
            hostId,
            resource,
            report: lifecycleReporter(deps, hostId),
            signal,
            checkpoint: (checkpoint) => {
              const parsed = resourceSchema.parse(checkpoint);
              const current = getHost(deps.db, hostId);
              if (
                current === null ||
                current.destroyedAt !== null ||
                current.machineProviderId !== record.provider.id ||
                (current.phase !== "suspending" && current.phase !== "retiring")
              ) {
                throw new Error(`Machine "${hostId}" is no longer active`);
              }
              updateHost(deps.db, deps.hub, hostId, {
                resource: parsed,
              });
            },
          }),
      );
      if (!invocation.ok) throw new Error(invocation.error);
      const result = resourceResultSchema.parse(invocation.value);
      const current = getHost(deps.db, hostId);
      if (
        current === null ||
        current.destroyedAt !== null ||
        current.machineProviderId !== record.provider.id ||
        (current.phase !== "suspending" && current.phase !== "retiring")
      ) {
        return;
      }
      updateHost(deps.db, deps.hub, hostId, {
        phase: current.phase === "retiring" ? "retiring" : "suspended",
        resource: result.resource,
        suspendedAt: Date.now(),
        teardownMessage: null,
        teardownStatus: null,
      });
      deps.hub.notifyHost(hostId, ["host-disconnected"]);
    },
  });
  await operation.done;
}

function requireSuspendableMachine(deps: Deps, hostId: string) {
  const row = getHost(deps.db, hostId);
  if (row === null || row.destroyedAt !== null) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  if (row.machineProviderId === null) {
    throw new ApiError(
      409,
      "machine_provider_unavailable",
      "This machine is not managed by a machine provider",
    );
  }
  const record = getMachineProvider(row.machineProviderId);
  if (
    record === undefined ||
    record.provider.suspend === null ||
    record.provider.resume === null
  ) {
    throw new ApiError(
      409,
      "machine_suspend_unsupported",
      `Machine provider "${row.machineProviderId}" does not support suspend and resume`,
    );
  }
  return row;
}

export async function requestMachineSuspension(
  deps: Deps,
  hostId: string,
): Promise<void> {
  const row = requireSuspendableMachine(deps, hostId);
  if (row.phase !== "active" && row.phase !== "suspending") {
    throw new ApiError(
      409,
      "machine_not_active",
      "Only an active machine can be suspended",
    );
  }
  await suspendMachine(deps, hostId);
}

export async function requestMachineResume(
  deps: Deps,
  hostId: string,
): Promise<void> {
  const row = requireSuspendableMachine(deps, hostId);
  if (row.phase !== "suspended" && row.phase !== "suspending") {
    throw new ApiError(
      409,
      "machine_not_suspended",
      "Only a suspended machine can be resumed",
    );
  }
  await resumeMachine(deps, hostId);
}

export async function resumeMachine(
  deps: MachineLifecycleDeps,
  hostId: string,
): Promise<void> {
  const removing = operations(removeOperations, deps.db).get(hostId);
  if (removing !== undefined) {
    await removing.done.catch(() => {});
    return;
  }
  const suspending = operations(suspendOperations, deps.db).get(hostId);
  if (suspending !== undefined) {
    await suspending.done.catch(() => {});
  }
  await resumeMachineWithIntent(deps, hostId, false);
}

async function resumeMachineWithIntent(
  deps: MachineLifecycleDeps,
  hostId: string,
  preserveRetirement: boolean,
): Promise<void> {
  let row = getHost(deps.db, hostId);
  if (row === null || row.machineProviderId === null) return;
  const hasLiveThreads = machineHasLiveThreads(deps.db, hostId);
  if (row.phase === "retiring" && row.suspendedAt === null && hasLiveThreads) {
    updateHost(deps.db, deps.hub, hostId, {
      phase: "active",
      retireAt: null,
      teardownMessage: null,
      teardownStatus: null,
    });
    return;
  }
  if (
    row.phase !== "suspended" &&
    row.phase !== "suspending" &&
    !(
      row.phase === "retiring" &&
      row.suspendedAt !== null &&
      (hasLiveThreads || preserveRetirement)
    )
  ) {
    return;
  }
  const machineProviderId = row.machineProviderId;
  const record = getMachineProvider(machineProviderId);
  if (record === undefined || record.provider.resume === null) {
    throw new ApiError(
      409,
      "machine_provider_unavailable",
      `Machine provider "${machineProviderId}" is not installed`,
    );
  }
  if (row.resource === null) {
    throw new Error(`Machine "${hostId}" has no provider resource`);
  }
  const resume = record.provider.resume;
  const resource = row.resource;
  const operation = runTrackedOperation({
    map: operations(resumeOperations, deps.db),
    key: hostId,
    run: async (signal) => {
      const invocation = await invokeMachineProvider(
        record,
        "machine resume",
        () =>
          resume({
            hostId,
            resource,
            report: lifecycleReporter(deps, hostId),
            signal,
          }),
      );
      if (!invocation.ok) throw new Error(invocation.error);
      const result = resourceResultSchema.parse(invocation.value);
      const current = getHost(deps.db, hostId);
      if (
        current === null ||
        current.destroyedAt !== null ||
        current.machineProviderId !== record.provider.id ||
        !["suspending", "suspended", "retiring"].includes(current.phase)
      ) {
        return;
      }
      const keepRetiring =
        current.phase === "retiring" && !machineHasLiveThreads(deps.db, hostId);
      updateHost(deps.db, deps.hub, hostId, {
        phase: keepRetiring ? "retiring" : "active",
        resource: result.resource,
        suspendedAt: null,
        retireAt: keepRetiring ? current.retireAt : null,
        teardownMessage: null,
        teardownStatus: null,
      });
      deps.hub.notifyHost(hostId, ["host-connected"]);
    },
  });
  await operation.done;
}

async function resumeRetiringMachine(
  deps: MachineLifecycleDeps,
  hostId: string,
): Promise<void> {
  await resumeMachineWithIntent(deps, hostId, true);
}

export function requestMachineRemoval(deps: Deps, hostId: string): boolean {
  const row = getHost(deps.db, hostId);
  if (row === null || row.destroyedAt !== null) return false;
  if (row.machineProviderId === null) return false;
  if (machineHasLiveThreads(deps.db, hostId)) return false;
  updateHost(deps.db, deps.hub, hostId, {
    phase: "retiring",
    retireAt: Date.now(),
    teardownStatus: null,
    teardownMessage: null,
  });
  deps.hub.notifyHost(hostId, ["host-disconnected"]);
  return true;
}

export async function retryMachineCleanup(
  deps: Deps,
  hostId: string,
): Promise<void> {
  const row = getHost(deps.db, hostId);
  if (row === null || row.destroyedAt !== null) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  if (
    row.machineProviderId === null ||
    row.phase !== "retiring" ||
    row.teardownStatus !== "failed"
  ) {
    throw new ApiError(
      409,
      "machine_cleanup_not_failed",
      "Cleanup can only be retried after machine teardown fails",
    );
  }
  updateHost(deps.db, deps.hub, hostId, { retireAt: Date.now() });
  await sweepProviderMachine(deps, hostId);
}

async function removeMachine(deps: Deps, hostId: string): Promise<void> {
  let removing = operations(removeOperations, deps.db).get(hostId);
  if (removing !== undefined) {
    await removing.done;
    return;
  }
  const suspending = operations(suspendOperations, deps.db).get(hostId);
  const resuming = operations(resumeOperations, deps.db).get(hostId);
  await Promise.all([
    suspending?.done.catch(() => {}),
    resuming?.done.catch(() => {}),
  ]);
  removing = operations(removeOperations, deps.db).get(hostId);
  if (removing !== undefined) {
    await removing.done;
    return;
  }
  const row = getHost(deps.db, hostId);
  if (row === null || row.machineProviderId === null) {
    return;
  }
  const record = getMachineProvider(row.machineProviderId);
  if (record === undefined) return;
  if (row.resource === null) {
    updateHost(deps.db, deps.hub, hostId, {
      teardownStatus: "failed",
      teardownMessage: `Machine "${hostId}" has no provider resource`,
      retireAt: Date.now() + record.provider.policy.removeRetryMs,
    });
    return;
  }
  const resource = row.resource;
  const attempt = row.teardownAttempt + 1;
  updateHost(deps.db, deps.hub, hostId, {
    teardownAttempt: attempt,
    teardownStatus: "running",
    teardownMessage: null,
  });
  const operation = runTrackedOperation({
    map: operations(removeOperations, deps.db),
    key: hostId,
    run: async (signal) => {
      try {
        await removeResource(deps, record, {
          hostId,
          resource,
          signal,
        });
        deleteMachineProjectSources(deps, hostId);
        await deps.machineAuth.revokeHostAuthKeys({ hostId });
        updateHost(deps.db, deps.hub, hostId, {
          destroyedAt: Date.now(),
          phase: "destroyed",
          resource: null,
          retireAt: null,
          suspendedAt: null,
          teardownStatus: "removed",
          teardownMessage: null,
        });
        deps.hub.notifyHost(hostId, ["host-disconnected"]);
      } catch (error) {
        updateHost(deps.db, deps.hub, hostId, {
          teardownStatus: "failed",
          teardownMessage: errorMessage(error),
          retireAt: Date.now() + record.provider.policy.removeRetryMs,
        });
      }
    },
  });
  await operation.done;
}

export async function sweepProviderMachine(
  deps: Deps,
  hostId: string,
): Promise<void> {
  let row = getHost(deps.db, hostId);
  if (
    row === null ||
    row.machineProviderId === null ||
    row.phase === "destroyed"
  ) {
    return;
  }
  const record = getMachineProvider(row.machineProviderId);
  if (record === undefined) return;
  if (row.phase === "suspending") {
    const suspending = operations(suspendOperations, deps.db).get(hostId);
    if (suspending !== undefined) {
      await suspending.done;
      return;
    }
    await resumeMachine(deps, hostId);
    return;
  }
  const now = Date.now();
  const hasLiveThreads = machineHasLiveThreads(deps.db, hostId);
  if (row.phase === "retiring" && hasLiveThreads) {
    updateHost(deps.db, deps.hub, hostId, {
      phase: row.suspendedAt === null ? "active" : "suspended",
      retireAt: null,
      teardownMessage: null,
      teardownStatus: null,
    });
    row = getHost(deps.db, hostId);
    if (row === null) return;
  }
  if (
    !hasLiveThreads &&
    record.provider.policy.retire.after === "last-thread"
  ) {
    const retireAt =
      row.retireAt ?? now + record.provider.policy.retire.graceMs;
    if (row.phase !== "retiring" || row.retireAt !== retireAt) {
      updateHost(deps.db, deps.hub, hostId, {
        phase: "retiring",
        retireAt,
      });
      row = getHost(deps.db, hostId);
      if (row === null) return;
    }
  }
  if (
    row.phase === "active" &&
    hasLiveThreads &&
    record.provider.policy.idleSuspendMs !== null &&
    record.provider.suspend !== null &&
    !machineHasOpenTerminal(deps.db, hostId)
  ) {
    const idleSince = machineIdleSince(deps.db, hostId);
    if (
      idleSince !== null &&
      now >= idleSince + record.provider.policy.idleSuspendMs
    ) {
      await suspendMachine(deps, hostId);
      return;
    }
  }
  if (row.phase !== "retiring" || row.retireAt === null || row.retireAt > now) {
    return;
  }
  const suspending = operations(suspendOperations, deps.db).get(hostId);
  const resuming = operations(resumeOperations, deps.db).get(hostId);
  await Promise.all([
    suspending?.done.catch(() => {}),
    resuming?.done.catch(() => {}),
  ]);
  row = getHost(deps.db, hostId);
  if (
    row === null ||
    row.destroyedAt !== null ||
    row.phase !== "retiring" ||
    row.retireAt === null ||
    row.retireAt > Date.now()
  ) {
    return;
  }
  if (machineHasLiveThreads(deps.db, hostId)) {
    updateHost(deps.db, deps.hub, hostId, {
      phase: row.suspendedAt === null ? "active" : "suspended",
      retireAt: null,
      teardownMessage: null,
      teardownStatus: null,
    });
    return;
  }
  const environments = listEnvironments(deps.db, { hostId }).filter(
    (environment) =>
      environment.status !== "destroyed" ||
      environment.teardownStatus !== "removed",
  );
  if (
    environments.some((environment) => environment.providerOwnsPath) &&
    row.suspendedAt !== null
  ) {
    await resumeRetiringMachine(deps, hostId);
    row = getHost(deps.db, hostId);
    if (row === null || row.phase !== "retiring") return;
  }
  let pendingEnvironment = false;
  for (const environment of environments) {
    requestEnvironmentRemoval(deps, environment.id);
    await sweepProviderEnvironment(deps, environment.id);
    const current = listEnvironments(deps.db, {
      hostId,
      limit: 1,
      statuses: ["provisioning", "ready", "error"],
    });
    if (current.length > 0) pendingEnvironment = true;
  }
  if (pendingEnvironment) return;
  if (
    row.teardownStatus === "failed" &&
    row.retireAt !== null &&
    row.retireAt > now
  ) {
    return;
  }
  await removeMachine(deps, hostId);
}

export async function sweepMachineLifecycles(deps: Deps): Promise<void> {
  for (const launch of listMachineLaunchesByPhase(deps.db, "creating")) {
    const record = getMachineProvider(launch.providerId);
    if (record !== undefined) startCreate(deps, record, launch);
  }
  for (const launch of listMachineLaunchesByPhase(deps.db, "cancelled")) {
    if (launch.cancelPending) {
      try {
        await cancelMachineLaunch(deps, launch.key);
      } catch (error) {
        deps.logger.warn(
          { key: launch.key, error: errorMessage(error) },
          "Machine launch cancellation will retry",
        );
      }
    }
  }
  for (const record of listMachineProviders()) {
    for (const machine of listProviderMachines(deps.db, record.provider.id)) {
      try {
        await sweepProviderMachine(deps, machine.id);
      } catch (error) {
        const current = getHost(deps.db, machine.id);
        if (current !== null && current.destroyedAt === null) {
          updateHost(deps.db, deps.hub, machine.id, {
            teardownAttempt: current.teardownAttempt + 1,
            teardownStatus: "failed",
            teardownMessage: errorMessage(error),
            ...(current.phase === "retiring"
              ? {
                  retireAt: Date.now() + record.provider.policy.removeRetryMs,
                }
              : {}),
          });
        }
        deps.logger.warn(
          { hostId: machine.id, error: errorMessage(error) },
          "Machine lifecycle sweep will retry",
        );
      }
    }
  }
}
