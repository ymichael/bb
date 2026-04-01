import { setTimeout as delay } from "node:timers/promises";
import {
  getActiveSession,
  getHost,
  updateHost,
} from "@bb/db";
import {
  resumeHost,
  resumeSandbox,
} from "@bb/sandbox-host";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { buildSandboxDaemonEnv } from "./sandbox-daemon-env.js";

const DEFAULT_SESSION_WAIT_TIMEOUT_MS = 60_000;
const SESSION_WAIT_INTERVAL_MS = 2_000;

export interface WaitForHostSessionOptions {
  timeoutMs?: number;
}

function toOptionalConfigString(value: string): string | undefined {
  return value === "" ? undefined : value;
}

export async function waitForHostSession(
  deps: Pick<AppDeps, "db">,
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
    if (Date.now() >= deadline) {
      throw new ApiError(
        504,
        "host_connection_timeout",
        "Sandbox host did not connect back to the server in time",
      );
    }
    await delay(SESSION_WAIT_INTERVAL_MS);
  }
}

async function loadSandboxHost(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
) {
  const host = getHost(deps.db, hostId);
  if (host?.destroyedAt !== null) {
    deps.sandboxRegistry.remove(hostId);
    return null;
  }

  const cached = deps.sandboxRegistry.get(hostId);
  if (cached) {
    return cached;
  }

  if (!host?.externalId) {
    return null;
  }
  const externalId = host.externalId;

  return deps.sandboxRegistry.getOrCreate(hostId, async () =>
    resumeHost({
      apiKey: toOptionalConfigString(deps.config.e2bApiKey),
      authToken: deps.config.authToken,
      daemonEnv: buildSandboxDaemonEnv(deps.config.githubPat),
      externalId,
      hostId: host.id,
      hostName: host.name,
      serverUrl: deps.config.publicUrl,
    }),
  );
}

export async function suspendIdleHost(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
): Promise<void> {
  const host = await loadSandboxHost(deps, hostId);
  if (host) {
    await host.suspend();
  }
}

export async function resumeSuspendedHost(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
) {
  const cached = deps.sandboxRegistry.get(hostId);
  const host = await loadSandboxHost(deps, hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  if (cached === host) {
    await host.resume();
  }
  return host;
}

export async function destroyHost(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "sandboxRegistry">,
  hostId: string,
): Promise<void> {
  const hostRecord = getHost(deps.db, hostId);
  if (hostRecord?.destroyedAt !== null) {
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

  if (!hostRecord?.externalId) {
    return;
  }

  deps.sandboxRegistry.remove(hostId);
  const sandbox = await resumeSandbox(hostRecord.externalId, {
    apiKey: toOptionalConfigString(deps.config.e2bApiKey),
  });
  await sandbox.kill();
  deps.sandboxRegistry.remove(hostId);
  updateHost(deps.db, deps.hub, hostId, { destroyedAt });
}
