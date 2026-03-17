export const DEFAULT_DAEMON_URL = "http://localhost:3333";

function normalizeValue(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveDaemonUrlFromEnv(): string | undefined {
  return normalizeValue(process.env.BB_DAEMON_URL);
}

export function resolveDaemonUrl(): string {
  return resolveDaemonUrlFromEnv() ?? DEFAULT_DAEMON_URL;
}

export function resolveProjectId(flagValue?: string): string | undefined {
  return normalizeValue(flagValue) ?? normalizeValue(process.env.BB_PROJECT_ID);
}

export function resolveThreadId(flagValue?: string): string | undefined {
  return normalizeValue(flagValue) ?? normalizeValue(process.env.BB_THREAD_ID);
}

export function resolveEnvironmentId(flagValue?: string): string | undefined {
  return normalizeValue(flagValue);
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
  throw new Error("Missing thread context. Pass <threadId> or set BB_THREAD_ID.");
}

export interface ContextSnapshot {
  projectId?: string;
  threadId?: string;
  daemonUrl: string;
  daemonUrlFromEnv?: string;
}

export function resolveContextSnapshot(): ContextSnapshot {
  const daemonUrlFromEnv = resolveDaemonUrlFromEnv();
  return {
    projectId: resolveProjectId(),
    threadId: resolveThreadId(),
    daemonUrl: daemonUrlFromEnv ?? DEFAULT_DAEMON_URL,
    daemonUrlFromEnv,
  };
}
