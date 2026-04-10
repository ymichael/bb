import {
  closeSession,
  getActiveSession,
  getHost,
  isEphemeralHostPendingCleanup,
  markHostResumed,
  markEphemeralHostActivity,
  markHostSuspended,
  sweepIdleEphemeralHostsEligibleForSuspend,
  updateHost,
} from "@bb/db";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "@bb/sandbox-host";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import type { AppDeps, SandboxLifecycleDeps, SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import type { HostLifecycleService } from "./host-lifecycle-service.js";
import { requireReachablePublicServerUrl } from "./public-server-url.js";
import { createSandboxBackendForId } from "./sandbox-backends.js";
import { requireSandboxBackendForHost } from "./sandbox-backends.js";
import { ensureSandboxRuntimeMaterialSynced } from "./sandbox-runtime-material.js";

const DEFAULT_SESSION_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_SANDBOX_ACTIVITY_EXTENSION_DEBOUNCE_MS = 30_000;
export const DEFAULT_SANDBOX_IDLE_THRESHOLD_MS = 300_000;

function pruneExpiredSandboxTimeoutExtensionEntries(
  state: HostLifecycleService,
  now: number,
): void {
  for (const [hostId, nextAllowedAt] of state.nextSandboxTimeoutExtensionAt) {
    if (nextAllowedAt <= now) {
      state.nextSandboxTimeoutExtensionAt.delete(hostId);
    }
  }
}

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
  state: HostLifecycleService,
  hostId: string,
  progressCallbacks: SandboxHostProgressCallbacks | undefined,
): () => void {
  if (!progressCallbacks) {
    return () => undefined;
  }

  let callbacksForHost = state.pendingReadyProgressCallbacks.get(hostId);
  if (!callbacksForHost) {
    callbacksForHost = new Set<SandboxHostProgressCallbacks>();
    state.pendingReadyProgressCallbacks.set(hostId, callbacksForHost);
  }
  callbacksForHost.add(progressCallbacks);

  return () => {
    const registeredCallbacks = state.pendingReadyProgressCallbacks.get(hostId);
    if (!registeredCallbacks) {
      return;
    }

    registeredCallbacks.delete(progressCallbacks);
    if (registeredCallbacks.size === 0) {
      state.pendingReadyProgressCallbacks.delete(hostId);
    }
  };
}

function notifyPendingReadyProgressCallbacks(
  state: HostLifecycleService,
  hostId: string,
  notify: (callbacks: SandboxHostProgressCallbacks) => void,
): void {
  const callbacksForHost = state.pendingReadyProgressCallbacks.get(hostId);
  if (!callbacksForHost) {
    return;
  }

  for (const callbacks of callbacksForHost) {
    notify(callbacks);
  }
}

function createPendingReadyProgressFanout(
  state: HostLifecycleService,
  hostId: string,
): SandboxHostProgressCallbacks {
  return {
    onProgress(event) {
      notifyPendingReadyProgressCallbacks(state, hostId, (callbacks) => {
        callbacks.onProgress?.(event);
      });
    },
    onSandboxCreated(args) {
      notifyPendingReadyProgressCallbacks(state, hostId, (callbacks) => {
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
  deps: Pick<AppDeps, "config" | "db" | "hostLifecycle" | "hub" | "sandboxRegistry">,
  hostId: string,
): Promise<void> {
  const state = deps.hostLifecycle;
  return state.hostDestroyDeduper.run(
    hostId,
    async () =>
      state.hostLifecycleLane.run(hostId, async () =>
        destroyHostInternal(deps, state, hostId)
      ),
  );
}

async function destroyHostInternal(
  deps: Pick<AppDeps, "config" | "db" | "hostLifecycle" | "hub" | "sandboxRegistry">,
  state: HostLifecycleService,
  hostId: string,
): Promise<void> {
  const hostRecord = getHost(deps.db, hostId);
  if (!hostRecord || hostRecord.destroyedAt !== null) {
    state.nextSandboxTimeoutExtensionAt.delete(hostId);
    deps.sandboxRegistry.remove(hostId);
    return;
  }

  const destroyedAt = Date.now();
  state.nextSandboxTimeoutExtensionAt.delete(hostId);
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
  deps: Pick<AppDeps, "config" | "db" | "hostLifecycle" | "hub" | "sandboxRegistry">,
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
  const state = deps.hostLifecycle;
  const unregisterProgressCallbacks = registerPendingReadyProgressCallbacks(
    state,
    args.hostId,
    args.progressCallbacks,
  );
  const progressFanout = createPendingReadyProgressFanout(state, args.hostId);

  try {
    await state.hostReadyDeduper.run(args.hostId, async () =>
      state.hostLifecycleLane.run(args.hostId, async () => {
        const host = getHost(deps.db, args.hostId);
        if (!host || host.destroyedAt !== null) {
          throw new ApiError(404, "host_not_found", "Host not found");
        }
        if (host.type !== "ephemeral") {
          throw new ApiError(
            409,
            "invalid_request",
            "Host is not an ephemeral sandbox",
          );
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
          markHostResumed(deps.db, {
            hostId: host.id,
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
      }),
    );
  } finally {
    unregisterProgressCallbacks();
  }
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
    await ensureSandboxHostSessionReady(deps, {
      hostId: host.id,
    });
  }

  return requireConnectedHostSession(deps, host.id);
}

export async function extendSandboxLifeIfNeeded(
  deps: Pick<AppDeps, "config" | "db" | "hostLifecycle" | "sandboxRegistry">,
  args: ExtendSandboxLifeIfNeededArgs,
): Promise<boolean> {
  const state = deps.hostLifecycle;
  const at = args.at ?? Date.now();
  pruneExpiredSandboxTimeoutExtensionEntries(state, at);
  const debounceWindowMs =
    args.debounceWindowMs ?? deps.config.sandboxActivityExtensionDebounceMs;
  const nextAllowedAt = state.nextSandboxTimeoutExtensionAt.get(args.hostId) ?? 0;
  if (at < nextAllowedAt) {
    return false;
  }
  state.nextSandboxTimeoutExtensionAt.set(args.hostId, at + debounceWindowMs);

  try {
    return await state.hostExtendDeduper.run(args.hostId, async () =>
      state.hostLifecycleLane.run(args.hostId, async () => {
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

        const cachedHost = deps.sandboxRegistry.get(host.id);
        if (cachedHost) {
          await cachedHost.extendTimeout(DEFAULT_SANDBOX_TIMEOUT_MS);
          return true;
        }

        const sandboxBackend = requireSandboxBackendForHost(host);
        await sandboxBackend.extendHostTimeout({
          config: deps.config,
          externalId: host.externalId,
          timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
        });
        return true;
      }),
    );
  } catch (error) {
    state.nextSandboxTimeoutExtensionAt.delete(args.hostId);
    throw error;
  }
}

export async function markSandboxActivity(
  deps: Pick<AppDeps, "config" | "db" | "hostLifecycle" | "logger" | "sandboxRegistry">,
  args: SandboxActivityArgs,
): Promise<void> {
  const at = args.at ?? Date.now();
  try {
    const host = markEphemeralHostActivity(deps.db, {
      hostId: args.hostId,
      lastActivityAt: at,
    });
    if (!host) {
      return;
    }

    await extendSandboxLifeIfNeeded(deps, {
      at,
      hostId: args.hostId,
    });
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        hostId: args.hostId,
        source: args.source,
      },
      "Failed to record sandbox activity",
    );
  }
}

export async function maybeSuspendIdleSandbox(
  deps: Pick<AppDeps, "config" | "db" | "hostLifecycle" | "hub" | "logger" | "sandboxRegistry">,
  args: MaybeSuspendIdleSandboxArgs,
): Promise<boolean> {
  const state = deps.hostLifecycle;
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

  return state.hostSuspendDeduper.run(host.id, async () =>
    state.hostLifecycleLane.run(host.id, async () => {
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

      state.nextSandboxTimeoutExtensionAt.delete(refreshedHost.id);
      const activeSession = getActiveSession(deps.db, refreshedHost.id);
      if (activeSession) {
        closeSession(deps.db, deps.hub, activeSession.id, "suspended");
      }
      markHostSuspended(deps.db, {
        hostId: refreshedHost.id,
        suspendedAt: now,
      });
      return true;
    }),
  ).catch((error) => {
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

export async function markHostSessionOpened(
  deps: Pick<AppDeps, "db" | "hostLifecycle">,
  args: { hostId: string },
): Promise<void> {
  const state = deps.hostLifecycle;
  await state.hostLifecycleLane.run(args.hostId, async () => {
    markHostResumed(deps.db, {
      hostId: args.hostId,
    });
  });
}
