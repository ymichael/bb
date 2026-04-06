import { hostTypeSchema, type HostType } from "@bb/domain";
import { z } from "zod";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";

interface DaemonAuthContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface AuthenticatedDaemon {
  hostId: string;
  hostType: HostType;
  keyId: string;
}

const authenticatedDaemonSchema = z.object({
  hostId: z.string().min(1),
  hostType: hostTypeSchema,
  keyId: z.string().min(1),
}).strict();

function isAuthenticatedDaemon(value: unknown): value is AuthenticatedDaemon {
  return authenticatedDaemonSchema.safeParse(value).success;
}

export function requireBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (token.length === 0) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }

  return token;
}

export async function verifyAuthenticatedDaemon(
  deps: Pick<AppDeps, "machineAuth">,
  authorizationHeader: string | undefined,
): Promise<AuthenticatedDaemon> {
  const token = requireBearerToken(authorizationHeader);
  const verified = await deps.machineAuth.verifyDaemonHostKey(token);
  if (!verified) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }

  return {
    hostId: verified.metadata.hostId,
    hostType: verified.metadata.hostType,
    keyId: verified.keyId,
  };
}

export function setAuthenticatedDaemon(
  context: DaemonAuthContext,
  daemon: AuthenticatedDaemon,
): void {
  context.set("authenticatedDaemon", daemon);
}

export function getAuthenticatedDaemon(context: DaemonAuthContext): AuthenticatedDaemon {
  const daemon = context.get("authenticatedDaemon");
  if (!isAuthenticatedDaemon(daemon)) {
    throw new ApiError(500, "internal_error", "Daemon authentication context missing");
  }
  return daemon;
}

export function assertAuthenticatedHostMatches(
  daemon: AuthenticatedDaemon,
  args: { hostId: string; hostType: HostType },
): void {
  if (daemon.hostId !== args.hostId || daemon.hostType !== args.hostType) {
    throw new ApiError(403, "invalid_request", "Authenticated host does not match request");
  }
}
