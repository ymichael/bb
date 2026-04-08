import {
  closeSession,
  getActiveSession,
  getHost,
  isEphemeralHostPendingCleanup,
  sweepIdleEphemeralHostsEligibleForSuspend,
  updateHost,
  updateHostLifecycleState,
} from "@bb/db";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "@bb/sandbox-host";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import type { AppDeps, SandboxLifecycleDeps, SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import { requireReachablePublicServerUrl } from "./public-server-url.js";
import { createSandboxBackendForId } from "./sandbox-backends.js";
import { requireSandboxBackendForHost } from "./sandbox-backends.js";
import { ensureSandboxRuntimeMaterialSynced } from "./sandbox-runtime-material.js";

const DEFAULT_SESSION_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_SANDBOX_ACTIVITY_EXTENSION_DEBOUNCE_MS = 30_000;
export const DEFAULT_SANDBOX_IDLE_THRESHOLD_MS = 300_000;
const hostDestroyDeduper = createAsyncDeduper<string, void>();
const hostExtendDeduper = createAsyncDeduper<string, boolean>();
const hostReadyDeduper = createAsyncDeduper<string, void>();
const hostSuspendDeduper = createAsyncDeduper<string, boolean>();
const nextSandboxTimeoutExtensionAt = new Map<string, number>();
const pendingReadyProgressCallbacks = new Map<
  string,
  Set<SandboxHostProgressCallbacks>
>();

export interface WaitForHostSessionOptions {
  timeoutMs?: number;
}

export interface SandboxActivityArgs {
  at?: number;
  hostId: string;
  source: "command-result" | "commands" | "events" | "tool-call";
}

export interface ExtendSandboxLifeIfNeededArgs {
  at?: number;
  debounceWindowMs?: number;
  hostId: string;
}

export interface MaybeSuspendIdleSandboxArgs {
  hostId: string;
  idleThresholdMs?: number;
  now?: number;
}

function registerPendingReadyProgressCallbacks(
  hostId: string,
  progressCallbacks: SandboxHostProgressCallbacks | undefined,
): () => void {
  if (!progressCallbacks) {
    return () => undefined;
  }

  let callbacksForHost = pendingReadyProgressCallbacks.get(hostId);
  if (!callbacksForHost) {
    callbacksForHost = new Set<SandboxHostProgressCallbacks>();
    pendingReadyProgressCallbacks.set(hostId, callbacksForHost);
  }
  callbacksForHost.add(progressCallbacks);

  return () => {
    const registeredCallbacks = pendingReadyProgressCallbacks.get(hostId);
    if (!registeredCallbacks) {
      return;
    }

    registeredCallbacks.delete(progressCallbacks);
    if (registeredCallbacks.size === 0) {
      pendingReadyProgressCallbacks.delete(hostId);
    }
  };
}

function notifyPendingReadyProgressCallbacks(
  hostId: string,
  notify: (callbacks: SandboxHostProgressCallbacks) => void,
): void {
  const callbacksForHost = pendingReadyProgressCallbacks.get(hostId);
  if (!callbacksForHost) {
    return;
  }

  for (const callbacks of callbacksForHost) {
    notify(callbacks);
  }
}

function createPendingReadyProgressFanout(
  hostId: string,
): SandboxHostProgressCallbacks {
  return {
    onProgress(event) {
      notifyPendingReadyProgressCallbacks(hostId, (callbacks) => {
        callbacks.onProgress?.(event);
      });
    },
    onSandboxCreated(args) {
      notifyPendingReadyProgressCallbacks(hostId, (callbacks) => {
        callbacks.onSandboxCreated?.(args);
      });
    },
  };
}

export async function waitForHostSession(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
  options: WaitForHostSessionOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const session = getActiveSession(deps.db, hostId);
    if (session) {
      return session;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ApiError(
        504,
        "host_connection_timeout",
        "Sandbox host did not connect back to the server in time",
      );
    }
    await deps.hub.waitForHostEvent(hostId, remainingMs);
  }
}

export async function destroyHost(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
): Promise<void> {
  return hostDestroyDeduper.run(hostId, async () => destroyHostInternal(deps, hostId));
}

async function destroyHostInternal(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
): Promise<void> {
  const hostRecord = getHost(deps.db, hostId);
  if (!hostRecord || hostRecord.destroyedAt !== null) {
    nextSandboxTimeoutExtensionAt.delete(hostId);
    deps.sandboxRegistry.remove(hostId);
    return;
  }

  const destroyedAt = Date.now();
  nextSandboxTimeoutExtensionAt.delete(hostId);
  const cached = deps.sandboxRegistry.get(hostId);
  if (cached) {
    await cached.destroy();
    deps.sandboxRegistry.remove(hostId);
    updateHost(deps.db, deps.hub, hostId, { destroyedAt });
    return;
  }

  if (!hostRecord.externalId) {
    deps.sandboxRegistry.remove(hostId);
    updateHost(deps.db, deps.hub, hostId, { destroyedAt });
    return;
  }

  deps.sandboxRegistry.remove(hostId);
  const sandboxBackend = requireSandboxBackendForHost(hostRecord);
  await sandboxBackend.destroyHost({
    config: deps.config,
    externalId: hostRecord.externalId,
  });
  // A concurrent resume can repopulate the registry while destroy is in flight.
  // Clear again after external teardown so no stale live handle survives.
  deps.sandboxRegistry.remove(hostId);
  updateHost(deps.db, deps.hub, hostId, { destroyedAt });
}

export async function destroyEphemeralHostIfReady(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
): Promise<boolean> {
  if (!isEphemeralHostPendingCleanup(deps.db, hostId)) {
    return false;
  }

  await destroyHost(deps, hostId);
  return true;
}

export async function ensureSandboxHostSessionReady(
  deps: SandboxLifecycleDeps,
  args: {
    hostId: string;
    progressCallbacks?: SandboxHostProgressCallbacks;
  },
) {
  const unregisterProgressCallbacks = registerPendingReadyProgressCallbacks(
    args.hostId,
    args.progressCallbacks,
  );
  const progressFanout = createPendingReadyProgressFanout(args.hostId);

  try {
    await hostReadyDeduper.run(args.hostId, async () => {
      const host = getHost(deps.db, args.hostId);
      if (!host || host.destroyedAt !== null) {
        throw new ApiError(404, "host_not_found", "Host not found");
      }
      if (host.type !== "ephemeral") {
        throw new ApiError(409, "invalid_request", "Host is not an ephemeral sandbox");
      }

      const cachedHost = deps.sandboxRegistry.get(args.hostId);
      const sandboxBackend =
        host.provider
          ? createSandboxBackendForId(host.provider)
          : requireSandboxBackendForHost(host);
      const serverUrl = requireReachablePublicServerUrl(deps.config);

      if (host.suspendedAt !== null) {
        if (host.externalId === null) {
          if (!cachedHost) {
            throw new ApiError(
              409,
              "invalid_request",
              "Suspended sandbox host is missing an external sandbox ID",
            );
          }
          await cachedHost.resume();
        } else {
          const resumedHost = await sandboxBackend.resumeHost({
            config: deps.config,
            externalId: host.externalId,
            hostId: host.id,
            hostName: host.name,
            progressCallbacks: progressFanout,
            serverUrl,
          });
          deps.sandboxRegistry.set(host.id, resumedHost);
        }
        updateHostLifecycleState(deps.db, {
          hostId: host.id,
          suspendedAt: null,
        });
      } else if (!cachedHost) {
        const sandboxHost =
          host.externalId
            ? await sandboxBackend.resumeHost({
                config: deps.config,
                externalId: host.externalId,
                hostId: host.id,
                hostName: host.name,
                progressCallbacks: progressFanout,
                serverUrl,
              })
            : await sandboxBackend.provisionHost({
                config: deps.config,
                enrollKey: (
                  await deps.machineAuth.issueHostEnrollKey({
                    hostId: host.id,
                    hostType: "ephemeral",
                  })
                ).key,
                hostId: host.id,
                hostName: host.name,
                progressCallbacks: {
                  ...progressFanout,
                  onSandboxCreated: ({ externalId }) => {
                    updateHost(deps.db, deps.hub, host.id, {
                      externalId,
                    });
                    progressFanout.onSandboxCreated?.({
                      externalId,
                    });
                  },
                },
                serverUrl,
              });

        updateHost(deps.db, deps.hub, host.id, {
          externalId: sandboxHost.externalId,
        });
        deps.sandboxRegistry.set(host.id, sandboxHost);
      }

      await waitForHostSession(deps, host.id);
      await ensureSandboxRuntimeMaterialSynced(deps, {
        hostId: host.id,
      });
    });
  } finally {
    unregisterProgressCallbacks();
  }
}

function hasSandboxLifecycleDeps(
  deps: SandboxWorkSessionDeps,
): deps is SandboxLifecycleDeps {
  return deps.config !== undefined
    && deps.machineAuth !== undefined
    && deps.sandboxRegistry !== undefined;
}

export async function ensureHostSessionReadyForWork(
  deps: SandboxWorkSessionDeps,
  args: { hostId: string },
) {
  const host = getHost(deps.db, args.hostId);
  if (!host || host.destroyedAt !== null) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  if (host.type === "ephemeral") {
    if (hasSandboxLifecycleDeps(deps)) {
      await ensureSandboxHostSessionReady(deps, {
        hostId: host.id,
      });
    }
  }

  return requireConnectedHostSession(deps, host.id);
}

export async function extendSandboxLifeIfNeeded(
  deps: Pick<AppDeps, "config" | "db" | "sandboxRegistry">,
  args: ExtendSandboxLifeIfNeededArgs,
): Promise<boolean> {
  const at = args.at ?? Date.now();
  const host = getHost(deps.db, args.hostId);
  if (
    !host
    || host.type !== "ephemeral"
    || host.destroyedAt !== null
    || host.externalId === null
    || host.suspendedAt !== null
  ) {
    return false;
  }

  const debounceWindowMs =
    args.debounceWindowMs ?? deps.config.sandboxActivityExtensionDebounceMs;
  const nextAllowedAt = nextSandboxTimeoutExtensionAt.get(host.id) ?? 0;
  if (at < nextAllowedAt) {
    return false;
  }
  nextSandboxTimeoutExtensionAt.set(host.id, at + debounceWindowMs);

  try {
    return await hostExtendDeduper.run(host.id, async () => {
      const cachedHost = deps.sandboxRegistry.get(host.id);
      if (cachedHost) {
        await cachedHost.extendTimeout(DEFAULT_SANDBOX_TIMEOUT_MS);
        return true;
      }

      const externalId = host.externalId;
      if (externalId === null) {
        return false;
      }
      const sandboxBackend = requireSandboxBackendForHost(host);
      await sandboxBackend.extendHostTimeout({
        config: deps.config,
        externalId,
        timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      });
      return true;
    });
  } catch (error) {
    nextSandboxTimeoutExtensionAt.delete(host.id);
    throw error;
  }
}

export async function markSandboxActivity(
  deps: Pick<AppDeps, "config" | "db" | "logger" | "sandboxRegistry">,
  args: SandboxActivityArgs,
): Promise<void> {
  const at = args.at ?? Date.now();
  const host = getHost(deps.db, args.hostId);
  if (!host || host.type !== "ephemeral" || host.destroyedAt !== null) {
    return;
  }

  updateHostLifecycleState(deps.db, {
    hostId: host.id,
    lastActivityAt: at,
  });

  try {
    await extendSandboxLifeIfNeeded(deps, {
      at,
      hostId: host.id,
    });
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        hostId: host.id,
        source: args.source,
      },
      "Failed to extend sandbox lifetime after activity",
    );
  }
}

export async function maybeSuspendIdleSandbox(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  args: MaybeSuspendIdleSandboxArgs,
): Promise<boolean> {
  const now = args.now ?? Date.now();
  const idleThresholdMs =
    args.idleThresholdMs ?? deps.config.sandboxIdleThresholdMs;
  const idleHosts = sweepIdleEphemeralHostsEligibleForSuspend(deps.db, {
    hostId: args.hostId,
    inactiveBefore: now - idleThresholdMs,
  });
  const host = idleHosts[0];
  if (!host) {
    return false;
  }

  return hostSuspendDeduper.run(host.id, async () => {
    const refreshedHost = sweepIdleEphemeralHostsEligibleForSuspend(deps.db, {
      hostId: host.id,
      inactiveBefore: now - idleThresholdMs,
    })[0];
    const externalId = refreshedHost?.externalId ?? null;
    if (!refreshedHost || externalId === null) {
      return false;
    }

    const cachedHost = deps.sandboxRegistry.get(refreshedHost.id);
    if (cachedHost) {
      await cachedHost.suspend();
    } else {
      const sandboxBackend = requireSandboxBackendForHost(refreshedHost);
      await sandboxBackend.suspendHost({
        config: deps.config,
        externalId,
      });
    }

    nextSandboxTimeoutExtensionAt.delete(refreshedHost.id);
    const activeSession = getActiveSession(deps.db, refreshedHost.id);
    if (activeSession) {
      closeSession(deps.db, deps.hub, activeSession.id, "suspended");
    }
    updateHostLifecycleState(deps.db, {
      hostId: refreshedHost.id,
      suspendedAt: now,
    });
    return true;
  }).catch((error) => {
    deps.logger.warn(
      {
        err: error,
        hostId: host.id,
      },
      "Idle sandbox suspend failed",
    );
    return false;
  });
}
