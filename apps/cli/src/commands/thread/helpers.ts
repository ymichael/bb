import {
  permissionModeSchema,
  type PermissionMode,
  type ThreadStatus,
  serviceTierSchema,
  type ServiceTier,
} from "@bb/domain";
import { assertNever } from "../../assert-never.js";
import { joinValues } from "../helpers.js";

export type ThreadWaitTarget =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "event"; eventType: string };

export const THREAD_WAIT_EXIT_CODE_TIMEOUT = 2;
export const THREAD_WAIT_EXIT_CODE_INVALID_REQUEST = 3;
export const THREAD_WAIT_EXIT_CODE_UNREACHABLE = 4;
export const DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS = 30;
export const DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS = 250;

const SERVICE_TIERS: ServiceTier[] = ["fast", "default"];
export const PERMISSION_MODE_HELP =
  "Permission mode: full, workspace-write, or readonly";
export const MANAGED_PERMISSION_MODE_HELP =
  "Permission mode: full, workspace-write, or readonly (managed threads deny escalations)";

export function statusText(status: ThreadStatus): string {
  switch (status) {
    case "created":
      return "created";
    case "provisioning":
      return "provisioning";
    case "error":
      return "error";
    case "idle":
      return "idle";
    case "active":
      return "active";
    default:
      return assertNever(status);
  }
}

export function parseThreadWaitTimeoutSeconds(
  value: string | undefined,
): number {
  if (value === undefined) return DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Timeout must be a non-negative number of seconds.");
  }
  return parsed;
}

export function parseThreadWaitPollIntervalMs(
  value: string | undefined,
): number {
  if (value === undefined) return DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      "Poll interval must be a positive integer number of milliseconds.",
    );
  }
  return parsed;
}

export function parseServiceTier(
  value: string | undefined,
): ServiceTier | undefined {
  if (value === undefined) return undefined;
  const parsed = serviceTierSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    `Invalid service tier '${value}'. Expected ${joinValues(SERVICE_TIERS)}.`,
  );
}

export function parsePermissionMode(
  value: string | undefined,
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  const parsed = permissionModeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    `Invalid permission mode '${value}'. Expected full, workspace-write, or readonly.`,
  );
}
