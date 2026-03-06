import type { SystemEnvironmentInfo } from "@beanbag/agent-core";
import {
  createLocalEnvironmentAdapter,
  createWorktreeEnvironmentAdapter,
} from "./environment-adapter.js";

export interface CreateEnvironmentAdapterOptions {
  environmentId?: string;
}

const SUPPORTED_ENVIRONMENT_IDS = ["local", "worktree"] as const;
type SupportedEnvironmentId = (typeof SUPPORTED_ENVIRONMENT_IDS)[number];

function isSupportedEnvironmentId(value: string): value is SupportedEnvironmentId {
  return SUPPORTED_ENVIRONMENT_IDS.includes(value as SupportedEnvironmentId);
}

function createEnvironmentForId(
  environmentId: SupportedEnvironmentId,
) {
  switch (environmentId) {
    case "local":
      return createLocalEnvironmentAdapter();
    case "worktree":
      return createWorktreeEnvironmentAdapter();
    default:
      throw new Error(`Unsupported environment "${environmentId}"`);
  }
}

export function listAvailableEnvironmentInfos(): SystemEnvironmentInfo[] {
  return SUPPORTED_ENVIRONMENT_IDS.map((environmentId) => {
    const adapter = createEnvironmentForId(environmentId);
    return {
      ...adapter.info,
    };
  });
}

export function createEnvironmentAdapter(opts?: CreateEnvironmentAdapterOptions) {
  const normalizedEnvironmentId = (
    opts?.environmentId ??
    process.env.BEANBAG_ENVIRONMENT ??
    "local"
  )
    .trim()
    .toLowerCase();

  if (!isSupportedEnvironmentId(normalizedEnvironmentId)) {
    throw new Error(
      `Unsupported environment "${normalizedEnvironmentId}". Supported environments: ${SUPPORTED_ENVIRONMENT_IDS.join(", ")}.`,
    );
  }

  return createEnvironmentForId(normalizedEnvironmentId);
}
