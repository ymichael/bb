export interface EnvironmentAgentSessionTimingOptions {
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  commandLongPollTimeoutMs?: number;
  commandLongPollIntervalMs?: number;
  leaseSweepIntervalMs?: number;
}

const ENVIRONMENT_AGENT_LEASE_TTL_MS_ENV = "BEANBAG_ENV_AGENT_LEASE_TTL_MS";
const ENVIRONMENT_AGENT_HEARTBEAT_INTERVAL_MS_ENV =
  "BEANBAG_ENV_AGENT_HEARTBEAT_INTERVAL_MS";
const ENVIRONMENT_AGENT_COMMAND_LONG_POLL_TIMEOUT_MS_ENV =
  "BEANBAG_ENV_AGENT_COMMAND_LONG_POLL_TIMEOUT_MS";
const ENVIRONMENT_AGENT_COMMAND_LONG_POLL_INTERVAL_MS_ENV =
  "BEANBAG_ENV_AGENT_COMMAND_LONG_POLL_INTERVAL_MS";
const ENVIRONMENT_AGENT_LEASE_SWEEP_INTERVAL_MS_ENV =
  "BEANBAG_ENV_AGENT_LEASE_SWEEP_INTERVAL_MS";
const ENVIRONMENT_AGENT_STARTUP_RECOVERY_REQUEST_TIMEOUT_MS_ENV =
  "BEANBAG_ENV_AGENT_STARTUP_RECOVERY_REQUEST_TIMEOUT_MS";

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const rawValue = env[name]?.trim();
  if (!rawValue) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveEnvironmentAgentSessionTimingOptions(
  env: NodeJS.ProcessEnv,
): EnvironmentAgentSessionTimingOptions {
  const leaseTtlMs = readPositiveIntegerEnv(env, ENVIRONMENT_AGENT_LEASE_TTL_MS_ENV);
  const heartbeatIntervalMs = readPositiveIntegerEnv(
    env,
    ENVIRONMENT_AGENT_HEARTBEAT_INTERVAL_MS_ENV,
  );
  const commandLongPollTimeoutMs = readPositiveIntegerEnv(
    env,
    ENVIRONMENT_AGENT_COMMAND_LONG_POLL_TIMEOUT_MS_ENV,
  );
  const commandLongPollIntervalMs = readPositiveIntegerEnv(
    env,
    ENVIRONMENT_AGENT_COMMAND_LONG_POLL_INTERVAL_MS_ENV,
  );
  const leaseSweepIntervalMs = readPositiveIntegerEnv(
    env,
    ENVIRONMENT_AGENT_LEASE_SWEEP_INTERVAL_MS_ENV,
  );
  return {
    ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
    ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
    ...(commandLongPollTimeoutMs !== undefined ? { commandLongPollTimeoutMs } : {}),
    ...(commandLongPollIntervalMs !== undefined ? { commandLongPollIntervalMs } : {}),
    ...(leaseSweepIntervalMs !== undefined ? { leaseSweepIntervalMs } : {}),
  };
}

export function resolveEnvironmentAgentStartupRecoveryRequestTimeoutMs(
  env: NodeJS.ProcessEnv,
): number | undefined {
  return readPositiveIntegerEnv(
    env,
    ENVIRONMENT_AGENT_STARTUP_RECOVERY_REQUEST_TIMEOUT_MS_ENV,
  );
}
