import type {
  AgentRuntimeContributedEnvEntry,
  AgentRuntimeShellEnvironment,
} from "./types.js";

interface ThreadShellEnvironmentArgs {
  environmentId: string;
  projectId?: string;
  threadStoragePath?: string;
  threadId: string;
}

interface BuildThreadShellEnvironmentArgs extends ThreadShellEnvironmentArgs {
  baseShellEnv: AgentRuntimeShellEnvironment | undefined;
}

export function buildThreadShellEnvironment(
  args: BuildThreadShellEnvironmentArgs,
): Record<string, string> {
  return {
    ...(args.baseShellEnv ?? {}),
    ...(args.projectId ? { BB_PROJECT_ID: args.projectId } : {}),
    ...(args.threadStoragePath
      ? { BB_THREAD_STORAGE: args.threadStoragePath }
      : {}),
    BB_THREAD_ID: args.threadId,
    BB_ENVIRONMENT_ID: args.environmentId,
  };
}

export interface ResolvedThreadEnvironmentEntry {
  name: string;
  source: "shell" | { plugin: string };
  value: string | { masked: true };
  reason?: string;
}

export interface DroppedThreadEnvironmentContribution {
  name: string;
  plugin: string;
}

interface ResolveThreadEnvironmentArgs extends ThreadShellEnvironmentArgs {
  baseShellEnv: AgentRuntimeShellEnvironment | undefined;
  contributedEnv: readonly AgentRuntimeContributedEnvEntry[];
}

export function resolveThreadEnvironment(args: ResolveThreadEnvironmentArgs): {
  droppedContributions: DroppedThreadEnvironmentContribution[];
  envVars: Record<string, string>;
  entries: ResolvedThreadEnvironmentEntry[];
} {
  const envVars = buildThreadShellEnvironment(args);
  const droppedContributions: DroppedThreadEnvironmentContribution[] = [];
  const entries: ResolvedThreadEnvironmentEntry[] = Object.entries(envVars).map(
    ([name, value]) => ({ name, source: "shell", value }),
  );
  for (const contribution of args.contributedEnv) {
    let value: string;
    if (typeof contribution.value === "string") {
      value = contribution.value;
    } else {
      const serverUrl = args.baseShellEnv?.BB_SERVER_URL;
      if (serverUrl === undefined) {
        entries.push({
          name: contribution.name,
          source: contribution.source,
          value: { masked: true },
          reason: `${contribution.reason} (dropped: no BB_SERVER_URL)`,
        });
        droppedContributions.push({
          name: contribution.name,
          plugin: contribution.source.plugin,
        });
        continue;
      }
      value = `${serverUrl}${contribution.value.serverPath}`;
    }
    envVars[contribution.name] = value;
    const existingIndex = entries.findIndex(
      (entry) => entry.name === contribution.name,
    );
    if (existingIndex !== -1) entries.splice(existingIndex, 1);
    entries.push({
      name: contribution.name,
      source: contribution.source,
      value: contribution.secret ? { masked: true } : value,
      reason: contribution.reason,
    });
  }
  return { droppedContributions, envVars, entries };
}
