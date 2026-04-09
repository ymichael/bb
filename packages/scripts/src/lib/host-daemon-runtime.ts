import type { HostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";

export interface HostDaemonRuntimeEnvironment extends HostDaemonEntrypointConfig {
  BB_DATA_DIR: string;
  BB_SERVER_URL: string;
  NODE_ENV: "development" | "production";
}

export function toHostDaemonProcessEnv(
  environment: HostDaemonRuntimeEnvironment,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  return childEnv;
}
