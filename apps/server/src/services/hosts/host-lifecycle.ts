import {
  getActiveSession,
  getHost,
  isEphemeralHostPendingCleanup,
  updateHost,
} from "@bb/db";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { requireReachablePublicServerUrl } from "./public-server-url.js";
import { createSandboxBackendForId } from "./sandbox-backends.js";
import { requireSandboxBackendForHost } from "./sandbox-backends.js";

const DEFAULT_SESSION_WAIT_TIMEOUT_MS = 60_000;
const hostDestroyDeduper = createAsyncDeduper<string, void>();
const hostReadyDeduper = createAsyncDeduper<string, void>();
const pendingReadyProgressCallbacks = new Map<
  string,
  Set<SandboxHostProgressCallbacks>
>();

export interface WaitForHostSessionOptions {
  timeoutMs?: number;
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
    deps.sandboxRegistry.remove(hostId);
    return;
  }

  const destroyedAt = Date.now();
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
  deps: Pick<
    AppDeps,
    "config" | "db" | "hub" | "machineAuth" | "sandboxRegistry"
  >,
  args: {
    hostId: string;
    progressCallbacks?: SandboxHostProgressCallbacks;
    sandboxType: string;
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

      const cachedHost = deps.sandboxRegistry.get(args.hostId);
      if (!cachedHost) {
        const sandboxBackend = createSandboxBackendForId(args.sandboxType);
        const serverUrl = requireReachablePublicServerUrl(deps.config);

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
    });
  } finally {
    unregisterProgressCallbacks();
  }
}
