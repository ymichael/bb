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
      capabilities: { ...adapter.info.capabilities },
    };
  });
}

export function createEnvironmentAdapter(opts?: CreateEnvironmentAdapterOptions) {
  const environmentId = (
    opts?.environmentId ??
    process.env.BEANBAG_ENVIRONMENT ??
    "local"
  )
    .trim()
    .toLowerCase();

  if (!SUPPORTED_ENVIRONMENT_IDS.includes(environmentId as SupportedEnvironmentId)) {
    throw new Error(
      `Unsupported environment "${environmentId}". Supported environments: ${SUPPORTED_ENVIRONMENT_IDS.join(", ")}.`,
    );
  }

  return createEnvironmentForId(environmentId as SupportedEnvironmentId);
}
