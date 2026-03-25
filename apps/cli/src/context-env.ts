import { cliConfig } from "@bb/config/cli";

function trimToUndefined(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveServerUrl(): string {
  return cliConfig.BB_SERVER_URL;
}

export function resolveHostDaemonUrl(): string {
  return `http://localhost:${cliConfig.BB_HOST_DAEMON_PORT}`;
}

export function resolveProjectId(flagValue?: string): string | undefined {
  return trimToUndefined(flagValue) ?? trimToUndefined(process.env.BB_PROJECT_ID);
}

export function resolveThreadId(flagValue?: string): string | undefined {
  return trimToUndefined(flagValue) ?? trimToUndefined(process.env.BB_THREAD_ID);
}

export function resolveEnvironmentId(flagValue?: string): string | undefined {
  return trimToUndefined(flagValue);
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
  serverUrl: string;
}

export function resolveContextSnapshot(): ContextSnapshot {
  return {
    projectId: resolveProjectId(),
    threadId: resolveThreadId(),
    serverUrl: cliConfig.BB_SERVER_URL,
  };
}
