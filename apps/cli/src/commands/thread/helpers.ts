import {
  createBuiltinPlanCommandTextInput,
  permissionModeInputSchema,
  type PermissionMode,
  type PromptInput,
  serviceTierSchema,
  type ServiceTier,
} from "@bb/domain";
import {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
} from "@bb/sdk";
import { joinValues } from "../helpers.js";

export const THREAD_WAIT_EXIT_CODE_TIMEOUT = 2;
export const THREAD_WAIT_EXIT_CODE_INVALID_REQUEST = 3;
export const THREAD_WAIT_EXIT_CODE_UNREACHABLE = 4;
export const DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS =
  DEFAULT_THREAD_WAIT_TIMEOUT_MS / 1000;

const SERVICE_TIERS: ServiceTier[] = ["fast", "default"];
export const PERMISSION_MODE_HELP =
  "Permission mode: accept-edits, auto, or full";
export const PLAN_HELP =
  "Send the message as the provider's /plan action so the agent proposes a plan for approval before executing";

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildPromptInputs(args: {
  message: string;
  files?: readonly string[];
  images?: readonly string[];
  plan?: boolean;
}): PromptInput[] {
  return [
    args.plan
      ? createBuiltinPlanCommandTextInput(args.message)
      : { type: "text", text: args.message, mentions: [] },
    ...(args.files ?? []).map((path): PromptInput => ({
      type: "localFile",
      path,
    })),
    ...(args.images ?? []).map((path): PromptInput => ({
      type: "localImage",
      path,
    })),
  ];
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
  const parsed = permissionModeInputSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    `Invalid permission mode '${value}'. Expected accept-edits, auto, or full.`,
  );
}
