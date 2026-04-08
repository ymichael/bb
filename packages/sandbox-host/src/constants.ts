import {
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE,
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
} from "@bb/host-daemon-contract";

export const DEFAULT_SANDBOX_CREATE_RETRIES = 2;
export const DEFAULT_SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;
export const SANDBOX_BB_EXECUTABLE_DIR = "/tmp";
export const SANDBOX_BB_EXECUTABLE_PATH = "/tmp/bb";
export const SANDBOX_BRIDGE_DIR = "/tmp";
export const SANDBOX_CLAUDE_CODE_BRIDGE_PATH = "/tmp/bb-claude-code-bridge.mjs";
export const SANDBOX_DATA_DIR = "/tmp/bb-data";
export const SANDBOX_PI_PACKAGE_DIR = "/tmp/bb-pi-package";
export const SANDBOX_PI_PACKAGE_MANIFEST_PATH =
  "/tmp/bb-pi-package/package.json";
export const SANDBOX_DAEMON_HEALTH_PATH = DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH;
export const SANDBOX_DAEMON_HEALTH_PORT =
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT;
export const SANDBOX_DAEMON_HEALTH_RESPONSE =
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE;
export const SANDBOX_DAEMON_PATH = "/tmp/bb-daemon.mjs";
export const SANDBOX_DAEMON_STDERR_PATH = "/tmp/bb-daemon.stderr.log";
export const SANDBOX_DAEMON_STDOUT_PATH = "/tmp/bb-daemon.stdout.log";
export const SANDBOX_DAEMON_HEALTH_RETRIES = 29;
export const SANDBOX_DAEMON_HEALTH_RETRY_MS = 2_000;
export const SANDBOX_DAEMON_FILE_WRITE_RETRIES = 2;
export const SANDBOX_DAEMON_FILE_WRITE_RETRY_MS = 1_000;
export const SANDBOX_PI_BRIDGE_PATH = "/tmp/bb-pi-bridge.mjs";
