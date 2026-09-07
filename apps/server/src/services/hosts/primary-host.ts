import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPublicHosts, type DbConnection } from "@bb/db";
import { HOST_ID_FILE_NAME } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  requireConnectedHostSession,
  requireNonDestroyedHostWithStatus,
} from "../lib/entity-lookup.js";

type PrimaryHostDeps = Pick<AppDeps, "config" | "db" | "hub">;

interface ReadPrimaryHostIdArgs {
  dataDir: string;
}

interface AssertUsableHostIdArgs {
  hostId: string;
}

function primaryHostUnavailableError(): ApiError {
  return new ApiError(
    502,
    "host_unavailable",
    "Local host daemon is not initialized",
  );
}

function readPrimaryHostIdFromDataDir(
  args: ReadPrimaryHostIdArgs,
): string | null {
  try {
    const value = readFileSync(
      join(args.dataDir, HOST_ID_FILE_NAME),
      "utf8",
    ).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function resolveSinglePublicHostId(db: DbConnection): string | null {
  const hosts = listPublicHosts(db);
  if (hosts.length !== 1) {
    return null;
  }
  const host = hosts[0];
  return host?.id ?? null;
}

function resolveSingleConnectedPublicHostId(
  deps: PrimaryHostDeps,
): string | null {
  const hosts = listPublicHosts(deps.db).filter((host) =>
    deps.hub.hasDaemonForHost(host.id),
  );
  if (hosts.length !== 1) {
    return null;
  }
  const host = hosts[0];
  return host?.id ?? null;
}

export function resolvePrimaryHostId(deps: PrimaryHostDeps): string | null {
  return (
    readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir }) ??
    resolveSingleConnectedPublicHostId(deps) ??
    resolveSinglePublicHostId(deps.db)
  );
}

export function requirePrimaryHostId(deps: PrimaryHostDeps): string {
  const hostId = resolvePrimaryHostId(deps);
  if (!hostId) {
    throw primaryHostUnavailableError();
  }
  return hostId;
}

export function assertUsableHostId(
  deps: PrimaryHostDeps,
  args: AssertUsableHostIdArgs,
): void {
  requireNonDestroyedHostWithStatus(deps, args.hostId);
}

export function requireConnectedPrimaryHostId(deps: PrimaryHostDeps): string {
  const hostId = requirePrimaryHostId(deps);
  requireNonDestroyedHostWithStatus(deps, hostId);
  requireConnectedHostSession(deps, hostId);
  return hostId;
}
