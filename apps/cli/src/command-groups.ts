import type { Command } from "commander";
import type { ContextSnapshot } from "./context-env.js";

export interface CommandGroupDeps {
  getUrl(): string;
  getContext(): ContextSnapshot;
}

export type CommandGroupRegistrar = (
  program: Command,
  deps: CommandGroupDeps,
) => void;

export interface CommandGroup {
  readonly name: string;
  readonly load: () => Promise<CommandGroupRegistrar>;
}

function group<Module>(
  name: string,
  load: () => Promise<Module>,
  register: (module: Module) => CommandGroupRegistrar,
): CommandGroup {
  return { name, load: () => load().then(register) };
}

export const CORE_COMMAND_GROUPS: readonly CommandGroup[] = [
  group(
    "browser",
    () => import("./commands/browser.js"),
    (m) => (program, deps) => m.registerBrowserCommands(program, deps.getUrl),
  ),
  group(
    "status",
    () => import("./commands/status.js"),
    (m) => (program, deps) =>
      m.registerStatusCommand(program, deps.getUrl, deps.getContext),
  ),
  group(
    "settings",
    () => import("./commands/settings.js"),
    (m) => (program, deps) => m.registerSettingsCommands(program, deps.getUrl),
  ),
  group(
    "project",
    () => import("./commands/project.js"),
    (m) => (program, deps) => m.registerProjectCommands(program, deps.getUrl),
  ),
  group(
    "provider",
    () => import("./commands/provider.js"),
    (m) => (program, deps) => m.registerProviderCommands(program, deps.getUrl),
  ),
  group(
    "manager",
    () => import("./commands/manager.js"),
    (m) => (program) => m.registerManagerCommands(program),
  ),
  group(
    "machine",
    () => import("./commands/machine.js"),
    (m) => (program, deps) => m.registerMachineCommands(program, deps.getUrl),
  ),
  group(
    "updates",
    () => import("./commands/updates.js"),
    (m) => (program, deps) => m.registerUpdatesCommands(program, deps.getUrl),
  ),
  group(
    "terminal",
    () => import("./commands/terminal.js"),
    (m) => (program, deps) => m.registerTerminalCommands(program, deps.getUrl),
  ),
  group(
    "thread",
    () => import("./commands/thread/index.js"),
    (m) => (program, deps) => m.registerThreadCommands(program, deps.getUrl),
  ),
  group(
    "environment",
    () => import("./commands/environment.js"),
    (m) => (program, deps) =>
      m.registerEnvironmentCommands(program, deps.getUrl),
  ),
  group(
    "file",
    () => import("./commands/file.js"),
    (m) => (program, deps) => m.registerFileCommands(program, deps.getUrl),
  ),
  group(
    "theme",
    () => import("./commands/theme.js"),
    (m) => (program, deps) => m.registerThemeCommands(program, deps.getUrl),
  ),
  group(
    "plugin",
    () => import("./commands/plugin.js"),
    (m) => (program, deps) => m.registerPluginCommands(program, deps.getUrl),
  ),
  group(
    "marketplace",
    () => import("./commands/marketplace.js"),
    (m) => (program, deps) =>
      m.registerMarketplaceCommands(program, deps.getUrl),
  ),
  group(
    "skill",
    () => import("./commands/skill.js"),
    (m) => (program, deps) =>
      m.registerSkillCommands(program, deps.getUrl, deps.getContext),
  ),
  group(
    "guide",
    () => import("./commands/guide.js"),
    (m) => (program) => m.registerGuideCommand(program),
  ),
  group(
    "voice",
    () => import("./commands/voice.js"),
    (m) => (program, deps) => m.registerVoiceCommands(program, deps.getUrl),
  ),
];

export function selectCommandGroups(
  firstArg: string | undefined,
): readonly CommandGroup[] {
  if (firstArg === "--version" || firstArg === "-V") return [];
  const match = CORE_COMMAND_GROUPS.find((entry) => entry.name === firstArg);
  return match === undefined ? CORE_COMMAND_GROUPS : [match];
}

export function pluginProxyCandidate(
  firstArg: string | undefined,
  knownCommandNames: ReadonlySet<string>,
): string | null {
  if (firstArg === undefined || firstArg.length === 0) return null;
  if (firstArg.startsWith("-")) return null;
  if (knownCommandNames.has(firstArg)) return null;
  return firstArg;
}
