import type { EnvironmentAgentConnectionTarget } from "@bb/environment-daemon";

const BB_ENV_DAEMON_BASE_URL = "BB_ENV_DAEMON_BASE_URL";
const BB_ENV_DAEMON_AUTH_TOKEN = "BB_ENV_DAEMON_AUTH_TOKEN";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveEnvironmentAgentConnectionTarget(args: {
  runtimeEnv: Record<string, string | undefined>;
  defaultTarget: EnvironmentAgentConnectionTarget;
}): EnvironmentAgentConnectionTarget {
  const baseUrl = args.runtimeEnv[BB_ENV_DAEMON_BASE_URL]?.trim();
  if (!baseUrl) {
    return args.defaultTarget;
  }

  const authToken = args.runtimeEnv[BB_ENV_DAEMON_AUTH_TOKEN]?.trim();
  return {
    transport: "http",
    baseUrl: normalizeBaseUrl(baseUrl),
    headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
    daemonConnection: args.defaultTarget.daemonConnection,
    providerLaunch: args.defaultTarget.providerLaunch,
  };
}
