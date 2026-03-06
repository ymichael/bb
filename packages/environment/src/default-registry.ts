import type { SystemEnvironmentInfo } from "@beanbag/agent-core";
import {
  EnvironmentRegistry,
  normalizeEnvironmentKind,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "./contracts.js";
import { createLocalEnvironmentDefinition } from "./local-environment.js";
import {
  createWorktreeEnvironmentDefinition,
  type CreateWorktreeEnvironmentDefinitionOptions,
} from "./worktree-environment.js";

export interface CreateDefaultEnvironmentRegistryOptions {
  worktree?: CreateWorktreeEnvironmentDefinitionOptions;
}

export function createDefaultEnvironmentRegistry(
  opts?: CreateDefaultEnvironmentRegistryOptions,
): EnvironmentRegistry {
  return new EnvironmentRegistry()
    .register(createLocalEnvironmentDefinition())
    .register(createWorktreeEnvironmentDefinition(opts?.worktree));
}

export function listAvailableEnvironmentInfos(
  registry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
): SystemEnvironmentInfo[] {
  return registry.list();
}

export function createEnvironment(
  kind: string | undefined,
  context: CreateEnvironmentContext,
  registry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
): IEnvironment {
  const resolvedKind = normalizeEnvironmentKind(
    kind ?? process.env.BEANBAG_ENVIRONMENT ?? "local",
  );
  return registry.create(resolvedKind, context);
}
