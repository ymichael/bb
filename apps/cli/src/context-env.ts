import { cliConfig } from "@bb/config/cli";
import { DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST } from "@bb/host-daemon-contract";

const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateId(value: string, source: string): string {
  if (!VALID_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ID from ${source}: "${value}". IDs must contain only letters, digits, hyphens, and underscores.`,
    );
  }
  return value;
}

function trimToUndefined(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveServerUrl(): string {
  return cliConfig.BB_SERVER_URL;
}

export function resolveHostDaemonUrl(): string {
  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${cliConfig.BB_HOST_DAEMON_PORT}`;
}

export function resolveProjectId(flagValue?: string): string | undefined {
  const fromFlag = trimToUndefined(flagValue);
  if (fromFlag) return validateId(fromFlag, "--project flag");
  const fromEnv = trimToUndefined(process.env.BB_PROJECT_ID);
  if (fromEnv) return validateId(fromEnv, "BB_PROJECT_ID");
  return undefined;
}

export function resolveThreadId(flagValue?: string): string | undefined {
  const fromFlag = trimToUndefined(flagValue);
  if (fromFlag) return validateId(fromFlag, "--thread flag");
  const fromEnv = trimToUndefined(process.env.BB_THREAD_ID);
  if (fromEnv) return validateId(fromEnv, "BB_THREAD_ID");
  return undefined;
}

export function resolveEnvironmentId(flagValue?: string): string | undefined {
  const fromFlag = trimToUndefined(flagValue);
  if (fromFlag) return validateId(fromFlag, "--environment flag");
  return undefined;
}

export function requireProjectId(flagValue?: string): string {
  const projectId = resolveProjectId(flagValue);
  if (projectId) return projectId;
  throw new Error(
    "Missing project context. Pass a project ID (for example --project <id>) or set BB_PROJECT_ID.",
  );
}

export function requireThreadId(flagValue?: string): string {
  const threadId = resolveThreadId(flagValue);
  if (threadId) return threadId;
  throw new Error(
    "Missing thread context. Pass <threadId> or set BB_THREAD_ID.",
  );
}

export interface ResolvedId {
  id: string;
  /** "arg" when provided as a positional/flag, "env" when resolved from the environment variable, "self" when explicitly targeted via --self. */
  source: "arg" | "env" | "self";
}

export interface ThreadSelfTargetOptions {
  self?: boolean;
}

/**
 * Resolve a project ID with source tracking. Returns undefined when neither the
 * flag nor the environment variable provides a value (useful for optional
 * project filters like thread list).
 */
export function resolveProjectIdWithLabel(
  flagValue?: string,
): ResolvedId | undefined {
  const fromFlag = trimToUndefined(flagValue);
  if (fromFlag)
    return { id: validateId(fromFlag, "--project flag"), source: "arg" };
  const fromEnv = trimToUndefined(process.env.BB_PROJECT_ID);
  if (fromEnv)
    return { id: validateId(fromEnv, "BB_PROJECT_ID"), source: "env" };
  return undefined;
}

/**
 * Require a project ID for read-only commands. Returns the resolved ID and its
 * source so the caller can print a context label when the value came from the
 * environment variable.
 */
export function requireProjectIdWithLabel(flagValue?: string): ResolvedId {
  const resolved = resolveProjectIdWithLabel(flagValue);
  if (resolved) return resolved;
  throw new Error(
    "Missing project context. Pass a project ID (for example --project <id>) or set BB_PROJECT_ID.",
  );
}

/**
 * Require a thread ID for read-only commands. Returns the resolved ID and its
 * source so the caller can print a context label when the value came from the
 * environment variable.
 */
export function requireThreadIdWithLabel(positionalId?: string): ResolvedId {
  const fromArg = trimToUndefined(positionalId);
  if (fromArg)
    return { id: validateId(fromArg, "<threadId> argument"), source: "arg" };
  const fromEnv = trimToUndefined(process.env.BB_THREAD_ID);
  if (fromEnv)
    return { id: validateId(fromEnv, "BB_THREAD_ID"), source: "env" };
  throw new Error(
    "Missing thread context. Pass <threadId> or set BB_THREAD_ID.",
  );
}

/**
 * Require a thread ID for read-only commands that support `--self`.
 *
 * - Positional `<id>` and `--self` are mutually exclusive.
 * - `--self` resolves from BB_THREAD_ID.
 * - If neither is provided, the command still falls back to BB_THREAD_ID and
 *   can print a context label for that implicit resolution.
 */
export function requireThreadIdWithLabelOrSelf(
  positionalId: string | undefined,
  opts: ThreadSelfTargetOptions,
): ResolvedId {
  if (opts.self && positionalId) {
    throw new Error("Cannot combine a thread ID argument with --self.");
  }
  if (positionalId) {
    return {
      id: validateId(positionalId, "<threadId> argument"),
      source: "arg",
    };
  }
  if (opts.self) {
    const envThreadId = resolveThreadId();
    if (!envThreadId) {
      throw new Error("--self requires BB_THREAD_ID to be set.");
    }
    return { id: envThreadId, source: "self" };
  }
  const fromEnv = trimToUndefined(process.env.BB_THREAD_ID);
  if (fromEnv) {
    return { id: validateId(fromEnv, "BB_THREAD_ID"), source: "env" };
  }
  throw new Error(
    "Missing thread context. Pass <threadId>, use --self, or set BB_THREAD_ID.",
  );
}

/**
 * Require a thread ID for mutating commands that support `--self`.
 *
 * - Positional `<id>` and `--self` are mutually exclusive.
 * - `--self` resolves from BB_THREAD_ID.
 * - If neither is provided, error with guidance.
 */
export function requireThreadIdOrSelf(
  positionalId: string | undefined,
  opts: ThreadSelfTargetOptions,
): string {
  if (opts.self && positionalId) {
    throw new Error("Cannot combine a thread ID argument with --self.");
  }
  if (opts.self) {
    const envThreadId = resolveThreadId();
    if (!envThreadId) {
      throw new Error("--self requires BB_THREAD_ID to be set.");
    }
    return envThreadId;
  }
  if (positionalId) {
    return validateId(positionalId, "<threadId> argument");
  }
  throw new Error(
    "Provide a thread ID or use --self to target the current thread.",
  );
}

export interface ContextSnapshot {
  projectId?: string;
  threadId?: string;
  serverUrl: string;
}

export function resolveContextSnapshot(): ContextSnapshot {
  return {
    projectId: resolveProjectId(),
    threadId: resolveThreadId(),
    serverUrl: cliConfig.BB_SERVER_URL,
  };
}
