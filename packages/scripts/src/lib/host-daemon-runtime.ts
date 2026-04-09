import type { HostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";

export interface HostDaemonRuntimeEnvironment extends HostDaemonEntrypointConfig {
  BB_DATA_DIR: string;
  BB_SERVER_URL: string;
  NODE_ENV: "development" | "production";
}

export function toHostDaemonProcessEnv(
  environment: HostDaemonRuntimeEnvironment,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...environment,
  };
}
