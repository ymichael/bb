import {
  sandboxModeSchema,
  type SandboxMode,
  type ThreadStatus,
  serviceTierSchema,
  type ServiceTier,
} from "@bb/domain";
import { assertNever } from "../../assert-never.js";

export type ThreadStatusEventMode = "summary" | "raw";
export type ThreadWaitTarget =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "event"; eventType: string };

export const THREAD_WAIT_EXIT_CODE_TIMEOUT = 2;
export const THREAD_WAIT_EXIT_CODE_INVALID_REQUEST = 3;
export const THREAD_WAIT_EXIT_CODE_UNREACHABLE = 4;
export const DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS = 30;
export const DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS = 250;

const THREAD_STATUS_EVENT_MODES: ThreadStatusEventMode[] = ["summary", "raw"];
const SERVICE_TIERS: ServiceTier[] = ["fast", "flex"];
const SANDBOX_MODES: SandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

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

export function parseRecentEventsCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Recent events count must be a positive integer.");
  }
  return parsed;
}

export function parseThreadStatusEventMode(
  value: string | undefined,
): ThreadStatusEventMode {
  const normalized = (value ?? "summary").trim().toLowerCase();
  if (normalized === "summary" || normalized === "raw") {
    return normalized;
  }
  throw new Error(
    `Invalid event mode '${value}'. Expected ${joinValues(THREAD_STATUS_EVENT_MODES)}.`,
  );
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

export function parseSandboxMode(
  value: string | undefined,
): SandboxMode | undefined {
  if (value === undefined) return undefined;
  const parsed = sandboxModeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    `Invalid sandbox mode '${value}'. Expected ${joinValues(SANDBOX_MODES)}.`,
  );
}

function joinValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(" or ");
}
