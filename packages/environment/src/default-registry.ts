import {
  EnvironmentRegistry,
  type CreateEnvironmentContext,
  type EnvironmentInfo,
  type IEnvironment,
} from "./contracts.js";
import { createLocalEnvironmentDefinition } from "./local-environment.js";
import {
  type CreateLocalGitWorkspaceOptions,
} from "./local-git-workspace.js";
import {
  createDockerEnvironmentDefinition,
  type CreateDockerEnvironmentDefinitionOptions,
} from "./docker-environment.js";

export interface CreateDefaultEnvironmentRegistryOptions {
  worktree?: CreateLocalGitWorkspaceOptions;
  docker?: CreateDockerEnvironmentDefinitionOptions;
}

export function createDefaultEnvironmentRegistry(
  opts?: CreateDefaultEnvironmentRegistryOptions,
): EnvironmentRegistry {
  const registry = new EnvironmentRegistry()
    .register(createLocalEnvironmentDefinition({
      ...(opts?.worktree ? { worktree: opts.worktree } : {}),
    }))
    .register(createDockerEnvironmentDefinition(opts?.docker));
  return registry;
}

export function listAvailableEnvironmentInfos(
  registry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
): EnvironmentInfo[] {
  return registry.list();
}

export function createEnvironment(
  kind: string | undefined,
  context: CreateEnvironmentContext,
  registry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
): IEnvironment {
  const resolvedKind = (kind ?? "local").trim();
  return registry.create(resolvedKind, context);
}
