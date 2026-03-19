import type { EnvironmentDaemonConnectionTarget } from "@bb/environment-daemon";

const BB_ENV_DAEMON_BASE_URL = "BB_ENV_DAEMON_BASE_URL";
const BB_ENV_DAEMON_AUTH_TOKEN = "BB_ENV_DAEMON_AUTH_TOKEN";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveEnvironmentDaemonConnectionTarget(args: {
  runtimeEnv: Record<string, string | undefined>;
  defaultTarget: EnvironmentDaemonConnectionTarget;
}): EnvironmentDaemonConnectionTarget {
  const baseUrl = args.runtimeEnv[BB_ENV_DAEMON_BASE_URL]?.trim();
  if (!baseUrl) {
    return args.defaultTarget;
  }

  const authToken = args.runtimeEnv[BB_ENV_DAEMON_AUTH_TOKEN]?.trim();
  return {
    transport: "http",
    baseUrl: normalizeBaseUrl(baseUrl),
    headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
    serverConnection: args.defaultTarget.serverConnection,
    providerLaunch: args.defaultTarget.providerLaunch,
  };
}
