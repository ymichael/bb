import {
  createMetadataPendingContext,
  threadProvisionCommonPayloadSchema,
  type ThreadProvisionContext,
} from "../threads/thread-provisioning-context.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  deleteFinishedEnvironmentLaunches,
  environmentHasLiveThreads,
  environments,
  getEnvironment,
  getEnvironmentLaunch,
  listCancelledEnvironmentLaunches,
  listProviderLifecycleEnvironments,
  saveEnvironmentLaunch,
  updateEnvironmentLaunch,
  type DbConnection,
  type DbTransaction,
  type EnvironmentLaunchRow,
  type EnvironmentRow,
} from "@bb/db";
import {
  jsonValueSchema,
  type Environment,
  type EnvironmentMachineSelection,
  type Host,
  type JsonValue,
  type Project,
} from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import type {
  PluginEnvironmentProviderCreateResult,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import type { ThreadProvisioningDeps } from "../threads/thread-provisioning-environment.js";
import { toEnvironmentResponse } from "./environment-response.js";
import {
  getEnvironmentProvider,
  invokeEnvironmentProvider,
  listEnvironmentProviders,
  requestEnvironmentProviderRecheck,
  type PluginEnvironmentProviderRecord,
} from "../plugins/plugin-environment-provider-registry.js";
import { applyLoggedEnvironmentLifecycleEvent } from "./lifecycle-outcome.js";

type Deps = ThreadProvisioningDeps;

interface ProviderOperationContext {
  thread: ThreadResponse;
  project: Project;
  host: Host;
  machine: EnvironmentMachineSelection;
  projectCheckout: { path: string } | null;
  gitRemote: string | null;
  inputs: JsonValue | null;
  suggestedBranchName: string;
  environment: Environment | null;
}

interface ActiveOperation {
  controller: AbortController;
  done: Promise<void>;
}

const resourceSchema = jsonValueSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value)) <= 16_384,
  "Resource exceeds 16 KiB",
);
const createResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("created"),
    path: z.string().min(1),
    ownsPath: z.boolean(),
    mergeBaseBranch: z.string().min(1).optional(),
    resource: resourceSchema.optional(),
  }),
  z.object({
    status: z.literal("failed"),
    failure: z.enum(["terminal", "transient"]),
    message: z.string().min(1),
  }),
]);
const removeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("removed") }),
  z.object({ status: z.literal("failed"), message: z.string().min(1) }),
]);
const createOperations = new WeakMap<object, Map<string, ActiveOperation>>();
const cancelOperations = new WeakMap<object, Map<string, ActiveOperation>>();
const removeOperations = new WeakMap<object, Map<string, ActiveOperation>>();

function operations(
  registry: WeakMap<object, Map<string, ActiveOperation>>,
  db: DbConnection,
): Map<string, ActiveOperation> {
  let map = registry.get(db);
  if (map === undefined) {
    map = new Map();
    registry.set(db, map);
  }
  return map;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutateLaunch(
  deps: Deps,
  launch: EnvironmentLaunchRow,
  phases: EnvironmentLaunchRow["phase"][],
  change: (row: EnvironmentLaunchRow) => void,
): boolean {
  const row = getEnvironmentLaunch(deps.db, launch.threadId);
  if (
    row === null ||
    row.attempt !== launch.attempt ||
    !phases.includes(row.phase)
  )
    return false;
  const before = JSON.stringify(row);
  change(row);
  if (JSON.stringify(row) === before) return false;
  return updateEnvironmentLaunch(deps.db, row);
}

function launchReporter(
  deps: Deps,
  record: PluginEnvironmentProviderRecord,
  launch: EnvironmentLaunchRow,
): PluginEnvironmentProviderProgress {
  const update = (change: (row: EnvironmentLaunchRow) => void): void => {
    if (mutateLaunch(deps, launch, ["creating"], change))
      requestEnvironmentProviderRecheck(record.pluginId);
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

function emptyReporter(): PluginEnvironmentProviderProgress {
  return { step: () => undefined, log: () => undefined };
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

class CreateTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Environment creation timed out after ${timeoutMs} ms.`);
  }
}

async function invokeCreate(
  record: PluginEnvironmentProviderRecord,
  context: Parameters<PluginEnvironmentProviderRecord["provider"]["create"]>[0],
  timeoutMs: number | null,
  controller: AbortController,
): Promise<PluginEnvironmentProviderCreateResult> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs !== null)
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  try {
    const invocation = await invokeEnvironmentProvider(
      record,
      "environment create",
      () => record.provider.create(context),
    );
    if (timedOut) throw new CreateTimeoutError(timeoutMs ?? 0);
    if (!invocation.ok) throw new Error(invocation.error);
    if (invocation.value === null)
      throw new Error("The environment provider became unavailable.");
    return createResultSchema.parse(invocation.value);
  } catch (error) {
    if (timedOut) throw new CreateTimeoutError(timeoutMs ?? 0);
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function runCreate(
  deps: Deps,
  record: PluginEnvironmentProviderRecord,
  launch: EnvironmentLaunchRow,
  context: ProviderOperationContext,
  outerSignal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outerSignal.addEventListener("abort", abort, { once: true });
  let changed = false;
  try {
    const previous =
      context.environment === null
        ? null
        : getEnvironment(deps.db, context.environment.id);
    const result = await invokeCreate(
      record,
      {
        thread: context.thread,
        project: context.project,
        host: context.host,
        projectCheckout: context.projectCheckout,
        gitRemote: context.gitRemote,
        inputs: context.inputs,
        suggestedBranchName: context.suggestedBranchName,
        pathKey: launch.pathKey,
        attempt: launch.attempt,
        rebuild: previous !== null,
        previous:
          previous === null
            ? null
            : {
                environment: toEnvironmentResponse(previous),
                resource:
                  previous.teardownStatus === "removed"
                    ? null
                    : previous.resource,
              },
        report: launchReporter(deps, record, launch),
        signal: controller.signal,
      },
      record.provider.policy.createTimeoutMs,
      controller,
    );
    changed = mutateLaunch(deps, launch, ["creating"], (row) => {
      if (result.status === "created") {
        row.phase = "ready";
        row.hostId = context.host.id;
        row.path = result.path;
        row.ownsPath = result.ownsPath;
        row.mergeBaseBranch = result.mergeBaseBranch ?? null;
        if (result.resource !== undefined) row.resource = result.resource;
      } else {
        row.phase = "failed";
        row.failure = result.failure;
        row.message = result.message;
        row.failedAt = Date.now();
        if (result.failure === "transient") row.transientFailures += 1;
      }
    });
  } catch (error) {
    const current = getEnvironmentLaunch(deps.db, launch.threadId);
    if (
      controller.signal.aborted &&
      current?.attempt === launch.attempt &&
      current.phase === "cancelled"
    )
      return;
    changed = mutateLaunch(deps, launch, ["creating"], (row) => {
      row.phase = "failed";
      row.failure =
        error instanceof CreateTimeoutError ? "transient" : "terminal";
      row.message =
        error instanceof CreateTimeoutError
          ? error.message
          : `The "${record.provider.id}" environment provider (plugin "${record.pluginId}") failed: ${message(error)}`;
      row.failedAt = Date.now();
      if (row.failure === "transient") row.transientFailures += 1;
    });
  } finally {
    outerSignal.removeEventListener("abort", abort);
    if (changed) requestEnvironmentProviderRecheck(record.pluginId);
  }
}

function startCreate(
  deps: Deps,
  record: PluginEnvironmentProviderRecord,
  launch: EnvironmentLaunchRow,
  context: ProviderOperationContext,
): ActiveOperation {
  return runTrackedOperation({
    map: operations(createOperations, deps.db),
    key: `${launch.threadId}:${launch.attempt}`,
    run: (signal) => runCreate(deps, record, launch, context, signal),
  });
}

export type ProviderLaunchDecision =
  | { action: "wait"; reason: string; sendAt: number; log: string }
  | { action: "reject"; message: string }
  | {
      action: "ready";
      environment: {
        type: "host";
        hostId: string;
        path: string;
        ownsPath: boolean;
        mergeBaseBranch?: string;
      };
      instanceKey: string;
      log: string;
    };

export function askProviderLaunch(
  deps: Deps,
  record: PluginEnvironmentProviderRecord,
  context: ProviderOperationContext,
  request: ThreadProvisionContext["request"] | null,
): ProviderLaunchDecision {
  const now = Date.now();
  const policy = record.provider.policy;
  const previous =
    context.environment === null
      ? null
      : getEnvironment(deps.db, context.environment.id);
  if (
    previous?.teardownStatus === "running" ||
    previous?.teardownStatus === "failed"
  )
    return {
      action: "wait",
      reason: "Removing the previous environment",
      sendAt: now + 1000,
      log: "",
    };
  let row = getEnvironmentLaunch(deps.db, context.thread.id);
  const selected = { machine: context.machine, inputs: context.inputs };
  const retryableFailure =
    row?.phase === "failed" &&
    row.failure === "transient" &&
    row.transientFailures <= policy.transientRetryLimit;
  const changed =
    row !== null &&
    (row.providerId !== record.provider.id ||
      JSON.stringify(row.selection) !== JSON.stringify(selected));
  const attached =
    row?.environmentId !== null && row?.environmentId !== undefined;
  if (
    row !== null &&
    row.environmentId === null &&
    ((changed && row.phase !== "cancelled") ||
      (row.phase === "cancelled" && row.cancelPending))
  ) {
    void cancelProviderLaunch(deps, row.threadId).catch((error) =>
      deps.logger.warn(
        { threadId: context.thread.id, error: message(error) },
        "Environment cancellation will retry",
      ),
    );
    return {
      action: "wait",
      reason: "Cancelling the previous environment launch",
      sendAt: now + 1000,
      log: "",
    };
  }
  if (row !== null && retryableFailure) {
    const cancelled = {
      ...row,
      phase: "cancelled" as const,
      cancelPending: true,
    };
    updateEnvironmentLaunch(deps.db, cancelled);
    void cancelProviderLaunch(deps, row.threadId).catch((error) =>
      deps.logger.warn(
        { threadId: row?.threadId, error: message(error) },
        "Environment cleanup before retry will retry",
      ),
    );
    return {
      action: "wait",
      reason: `${row.message}; cleaning up before retry`.slice(0, 200),
      sendAt: now + 1000,
      log: "",
    };
  }
  const retryRow =
    row?.phase === "cancelled" &&
    row.failure === "transient" &&
    !changed &&
    row.transientFailures <= policy.transientRetryLimit
      ? row
      : null;
  const retryAt = (retryRow?.failedAt ?? now) + policy.transientRetryMs;
  if (retryRow !== null && now < retryAt)
    return {
      action: "wait",
      reason: `${retryRow.message}; retrying`.slice(0, 200),
      sendAt: retryAt,
      log: "",
    };
  const start =
    row === null ||
    row.attempt === 0 ||
    changed ||
    row.phase === "cancelled" ||
    attached;
  if (start) {
    const attempt = (row?.attempt ?? 0) + 1;
    const pathKey =
      policy.pathKeys === "per-attempt" ||
      context.environment !== null ||
      attached
        ? `${context.thread.id}-${attempt}`
        : context.thread.id;
    row = {
      threadId: context.thread.id,
      providerId: record.provider.id,
      attempt,
      phase: "creating",
      startedAt: now,
      failedAt: null,
      failure: null,
      message: null,
      transientFailures: retryRow?.transientFailures ?? 0,
      pathKey,
      hostId: context.host.id,
      path: null,
      ownsPath: true,
      mergeBaseBranch: null,
      resource: null,
      stepText: `${context.environment === null ? "Preparing" : "Restoring"} ${record.provider.displayName}…`,
      pendingLog: "",
      replacedEnvironmentId: context.environment?.id ?? null,
      environmentId: null,
      selection: selected,
      cancelPending: false,
      request: request === null ? null : jsonValueSchema.parse(request),
    };
    saveEnvironmentLaunch(deps.db, row);
    startCreate(deps, record, row, context);
  }
  if (row === null) throw new Error("Missing environment launch");
  const log = row.pendingLog;
  if (log.length > 0)
    updateEnvironmentLaunch(deps.db, { ...row, pendingLog: "" });
  if (row.phase === "ready" && row.hostId !== null && row.path !== null)
    return {
      action: "ready",
      environment: {
        type: "host",
        hostId: row.hostId,
        path: row.path,
        ownsPath: row.ownsPath,
        ...(row.mergeBaseBranch === null
          ? {}
          : { mergeBaseBranch: row.mergeBaseBranch }),
      },
      instanceKey: row.pathKey,
      log,
    };
  if (row.phase === "failed") {
    updateEnvironmentLaunch(deps.db, {
      ...row,
      phase: "cancelled",
      cancelPending: true,
    });
    void cancelProviderLaunch(deps, row.threadId).catch((error) =>
      deps.logger.warn(
        { threadId: row?.threadId, error: message(error) },
        "Environment cleanup will retry",
      ),
    );
    return {
      action: "reject",
      message: row.message ?? "Environment creation failed",
    };
  }
  if (row.phase === "creating") startCreate(deps, record, row, context);
  return { action: "wait", reason: row.stepText, sendAt: now + 1000, log };
}

export function attachProviderLaunch(
  db: DbConnection | DbTransaction,
  threadId: string,
  environmentId: string,
): void {
  const row = getEnvironmentLaunch(db, threadId);
  if (row === null || row.phase !== "ready") return;
  db.update(environments)
    .set({ resource: row.resource, retireAt: null })
    .where(eq(environments.id, environmentId))
    .run();
  updateEnvironmentLaunch(db, { ...row, environmentId });
}

async function runCancel(
  deps: Deps,
  launch: EnvironmentLaunchRow,
  signal: AbortSignal,
): Promise<void> {
  const record = getEnvironmentProvider(launch.providerId);
  if (record === undefined)
    throw new Error(
      `Environment provider "${launch.providerId}" is unavailable.`,
    );
  const invocation = await invokeEnvironmentProvider(
    record,
    "environment cancel cleanup",
    () =>
      record.provider.remove({
        environment: null,
        hostId: launch.hostId,
        path: launch.path,
        pathKey: launch.pathKey,
        resource: launch.resource,
        attempt: launch.attempt,
        report: emptyReporter(),
        signal,
      }),
  );
  if (!invocation.ok) throw new Error(invocation.error);
  if (invocation.value === null)
    throw new Error("The environment provider became unavailable.");
  const result = removeResultSchema.parse(invocation.value);
  if (result.status === "failed") throw new Error(result.message);
  mutateLaunch(deps, launch, ["cancelled"], (row) => {
    row.cancelPending = false;
    row.hostId = null;
    row.path = null;
    row.resource = null;
  });
}

export async function cancelProviderLaunch(
  deps: Deps,
  threadId: string,
): Promise<void> {
  const row = getEnvironmentLaunch(deps.db, threadId);
  if (row === null || row.environmentId !== null) return;
  if (row.phase === "cancelled" && !row.cancelPending) return;
  const cancelled: EnvironmentLaunchRow = {
    ...row,
    phase: "cancelled",
    cancelPending: true,
  };
  updateEnvironmentLaunch(deps.db, cancelled);
  const create = operations(createOperations, deps.db).get(
    `${row.threadId}:${row.attempt}`,
  );
  if (create !== undefined) {
    create.controller.abort();
    await create.done;
  }
  const operation = runTrackedOperation({
    map: operations(cancelOperations, deps.db),
    key: threadId,
    run: (signal) => runCancel(deps, cancelled, signal),
  });
  await operation.done;
}

export function requestEnvironmentRemoval(
  deps: Deps,
  environmentId: string,
): boolean {
  const row = getEnvironment(deps.db, environmentId);
  if (row === null || environmentHasLiveThreads(deps.db, environmentId))
    return false;
  if (row.status === "destroyed") return true;
  if (row.environmentProviderId === null) {
    return applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId,
      event: { type: "destroy.recorded" },
    }).applied;
  }
  if (row.teardownStatus === null) {
    deps.db
      .update(environments)
      .set({
        status: "error",
        retireAt: Date.now(),
        teardownStatus: "running",
      })
      .where(eq(environments.id, environmentId))
      .run();
    deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
  }
  return true;
}

async function runRemove(
  deps: Deps,
  environmentId: string,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  const row = getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    row.teardownStatus !== "running"
  )
    return;
  const record = getEnvironmentProvider(row.environmentProviderId);
  if (record === undefined) return;
  const write = (change: Partial<EnvironmentRow>): void => {
    deps.db
      .update(environments)
      .set(change)
      .where(eq(environments.id, environmentId))
      .run();
    deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
  };
  try {
    const invocation = await invokeEnvironmentProvider(
      record,
      "environment remove",
      () =>
        record.provider.remove({
          environment: toEnvironmentResponse(row),
          hostId: row.hostId,
          path: row.path,
          pathKey: row.environmentProviderInstanceKey ?? row.id,
          resource: row.resource,
          attempt,
          report: emptyReporter(),
          signal,
        }),
    );
    if (!invocation.ok) throw new Error(invocation.error);
    if (invocation.value === null)
      throw new Error("The environment provider became unavailable.");
    const result = removeResultSchema.parse(invocation.value);
    if (result.status === "failed") {
      write({
        teardownStatus: "failed",
        teardownMessage: result.message,
        retireAt: Date.now() + record.provider.policy.removeRetryMs,
      });
      return;
    }
    write({
      teardownStatus: "removed",
      teardownMessage: null,
      resource: null,
      retireAt: null,
    });
    applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId,
      event: { type: "destroy.recorded" },
    });
  } catch (error) {
    write({
      teardownStatus: "failed",
      teardownMessage: message(error),
      retireAt: Date.now() + record.provider.policy.removeRetryMs,
    });
  }
}

export async function sweepProviderEnvironment(
  deps: Deps,
  environmentId: string,
): Promise<void> {
  const active = operations(removeOperations, deps.db).get(environmentId);
  if (active !== undefined) {
    await active.done;
    return;
  }
  let row = getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    row.teardownStatus === "removed"
  )
    return;
  const record = getEnvironmentProvider(row.environmentProviderId);
  if (record === undefined) return;
  const now = Date.now();
  const write = (change: Partial<EnvironmentRow>): void => {
    deps.db
      .update(environments)
      .set(change)
      .where(eq(environments.id, environmentId))
      .run();
    deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
  };
  if (environmentHasLiveThreads(deps.db, environmentId)) {
    if (row.retireAt !== null && row.teardownStatus === null)
      write({ retireAt: null });
    return;
  }
  if (row.retireAt === null) {
    if (
      record.provider.policy.retireGraceMs === null &&
      row.status !== "destroyed"
    )
      return;
    const retireAt =
      row.status === "destroyed"
        ? now
        : now + (record.provider.policy.retireGraceMs ?? 0);
    write({ retireAt });
    row = { ...row, retireAt };
  }
  if (row.retireAt !== null && row.retireAt > now) return;
  if (!requestEnvironmentRemoval(deps, environmentId)) return;
  row = getEnvironment(deps.db, environmentId);
  if (row === null || row.teardownStatus === "removed") return;
  if (
    row.teardownStatus === "failed" &&
    row.retireAt !== null &&
    row.retireAt > now
  )
    return;
  const attempt =
    row.teardownStatus === "running" && row.teardownAttempt > 0
      ? row.teardownAttempt
      : row.teardownAttempt + 1;
  write({
    status: row.status === "destroyed" ? "destroyed" : "error",
    teardownStatus: "running",
    teardownAttempt: attempt,
    teardownMessage: null,
  });
  const operation = runTrackedOperation({
    map: operations(removeOperations, deps.db),
    key: environmentId,
    run: (signal) => runRemove(deps, environmentId, attempt, signal),
  });
  await operation.done;
}

export async function sweepProviderLifecycles(deps: Deps): Promise<void> {
  for (const row of listCancelledEnvironmentLaunches(deps.db)) {
    try {
      await cancelProviderLaunch(deps, row.threadId);
    } catch (error) {
      deps.logger.warn(
        { threadId: row.threadId, error: message(error) },
        "Environment cancellation will retry",
      );
    }
  }
  for (const record of listEnvironmentProviders()) {
    for (const row of listProviderLifecycleEnvironments(
      deps.db,
      record.provider.id,
    ))
      await sweepProviderEnvironment(deps, row.id);
  }
  deleteFinishedEnvironmentLaunches(deps.db);
}

export function providerLaunchHasPendingWork(
  db: DbConnection | DbTransaction,
  threadId: string,
): boolean {
  const row = getEnvironmentLaunch(db, threadId);
  if (row === null) return false;
  if (row.cancelPending) return true;
  return (
    row.environmentId === null &&
    (row.phase === "creating" || row.phase === "ready")
  );
}

export function refreshProviderRetirement(
  deps: {
    db: DbConnection | DbTransaction;
    hub: Pick<Deps["hub"], "notifyEnvironment">;
  },
  environmentId: string,
): void {
  const row = getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    row.teardownStatus !== null
  )
    return;
  const provider = getEnvironmentProvider(row.environmentProviderId);
  if (provider === undefined) return;
  const grace = provider.provider.policy.retireGraceMs;
  const retireAt =
    grace === null || environmentHasLiveThreads(deps.db, environmentId)
      ? null
      : (row.retireAt ?? Date.now() + grace);
  if (row.retireAt === retireAt) return;
  deps.db
    .update(environments)
    .set({ retireAt })
    .where(eq(environments.id, environmentId))
    .run();
  deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
}

export function restoreProviderLaunchContext(
  db: DbConnection,
  threadId: string,
): ThreadProvisionContext | null {
  const launch = getEnvironmentLaunch(db, threadId);
  if (
    launch === null ||
    launch.request === null ||
    launch.phase === "cancelled"
  )
    return null;
  const request = threadProvisionCommonPayloadSchema.parse(launch.request);
  return createMetadataPendingContext({
    ...request,
    environmentIntent:
      launch.environmentId === null
        ? request.environmentIntent
        : { type: "reuse", environmentId: launch.environmentId },
  });
}

export async function restoreFailedProviderLaunchRequest(
  deps: Deps,
  threadId: string,
): Promise<ThreadProvisionContext["request"] | null> {
  let launch = getEnvironmentLaunch(deps.db, threadId);
  if (
    launch === null ||
    launch.environmentId !== null ||
    launch.request === null
  )
    return null;
  if (launch.phase !== "cancelled" || launch.cancelPending) {
    await cancelProviderLaunch(deps, threadId);
    launch = getEnvironmentLaunch(deps.db, threadId);
    if (
      launch === null ||
      launch.environmentId !== null ||
      launch.request === null ||
      launch.cancelPending
    )
      return null;
  }
  return threadProvisionCommonPayloadSchema.parse(launch.request);
}

export function persistPendingProviderRequest(
  db: DbConnection,
  threadId: string,
  request: ThreadProvisionContext["request"],
): void {
  const intent = request.environmentIntent;
  if (intent.type !== "provider" || getEnvironmentLaunch(db, threadId) !== null)
    return;
  saveEnvironmentLaunch(db, {
    threadId,
    providerId: intent.environmentProviderId,
    attempt: 0,
    phase: "creating",
    startedAt: Date.now(),
    failedAt: null,
    failure: null,
    message: null,
    transientFailures: 0,
    pathKey: threadId,
    hostId: intent.machine.type === "existing" ? intent.machine.hostId : null,
    path: null,
    ownsPath: true,
    mergeBaseBranch: null,
    resource: null,
    stepText: "Waiting for the environment provider",
    pendingLog: "",
    replacedEnvironmentId: null,
    environmentId: null,
    selection: { machine: intent.machine, inputs: intent.inputs },
    request: jsonValueSchema.parse(request),
    cancelPending: false,
  });
}
