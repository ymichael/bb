import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";

const BEANBAG_ENVIRONMENT_AGENT_BASE_URL = "BEANBAG_ENVIRONMENT_AGENT_BASE_URL";
const BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN = "BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveEnvironmentAgentConnectionTarget(args: {
  runtimeEnv: Record<string, string | undefined>;
  defaultTarget: EnvironmentAgentConnectionTarget;
}): EnvironmentAgentConnectionTarget {
  const baseUrl = args.runtimeEnv[BEANBAG_ENVIRONMENT_AGENT_BASE_URL]?.trim();
  if (!baseUrl) {
    return args.defaultTarget;
  }

  const authToken = args.runtimeEnv[BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN]?.trim();
  return {
    transport: "http",
    baseUrl: normalizeBaseUrl(baseUrl),
    headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
    daemonConnection: args.defaultTarget.daemonConnection,
    providerLaunch: args.defaultTarget.providerLaunch,
  };
}
