import { join } from "node:path";
import { resolveBbPath } from "@bb/core/storage-paths";
import {
  createRotatingJsonLineFileWriter,
  removeRotatingJsonLineFileArtifacts,
} from "./rotating-file-logger.js";

const BB_ENV_DAEMON_LOG_FILE = "BB_ENV_DAEMON_LOG_FILE";
const DEFAULT_ENVIRONMENT_AGENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ENVIRONMENT_AGENT_LOG_MAX_FILES = 3;

export interface EnvironmentDaemonLogIdentity {
  projectId: string | undefined;
  threadId: string | undefined;
  environmentId: string | undefined;
  runtimeEnv?: NodeJS.ProcessEnv;
}

function sanitizeSegment(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

export function resolveEnvironmentDaemonLogFilePath(
  env: NodeJS.ProcessEnv,
): string {
  const configured = env[BB_ENV_DAEMON_LOG_FILE]?.trim();
  if (configured) {
    return configured;
  }

  return resolveDefaultEnvironmentDaemonLogFilePath({
    projectId: env.BB_PROJECT_ID,
    threadId: env.BB_THREAD_ID,
    environmentId: env.BB_ENVIRONMENT_ID,
    runtimeEnv: env,
  });
}

export function resolveDefaultEnvironmentDaemonLogFilePath(
  identity: EnvironmentDaemonLogIdentity,
): string {
  return join(
    resolveBbPath(identity.runtimeEnv, "environment-daemon-logs"),
    sanitizeSegment(identity.projectId),
    `${sanitizeSegment(identity.environmentId)}-${sanitizeSegment(identity.threadId)}.log`,
  );
}

export function removeEnvironmentDaemonDefaultLogArtifacts(
  identity: EnvironmentDaemonLogIdentity,
): void {
  removeRotatingJsonLineFileArtifacts(resolveDefaultEnvironmentDaemonLogFilePath(identity));
}

export interface EnvironmentDaemonFileLogger {
  readonly filePath: string;
  log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
}

export function createEnvironmentDaemonFileLogger(
  filePath: string,
): EnvironmentDaemonFileLogger {
  const writer = createRotatingJsonLineFileWriter({
    filePath,
    maxBytes: DEFAULT_ENVIRONMENT_AGENT_LOG_MAX_BYTES,
    maxFiles: DEFAULT_ENVIRONMENT_AGENT_LOG_MAX_FILES,
  });
  return {
    filePath: writer.filePath,
    log(level, message, meta) {
      writer.write({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...(meta ? { meta } : {}),
      });
    },
  };
}
