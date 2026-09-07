import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledPluginDefinition {
  name: string;
  pluginId: string;
  autoInstall: boolean;
  defaultEnabled: boolean;
}

export interface BundledPluginRegistration extends BundledPluginDefinition {
  rootDir: string;
}

interface ResolveBuiltinPluginRootPathArgs {
  moduleDir: string;
  name: string;
}

export const BUILTIN_PLUGINS_DIRECTORY_NAME = "builtin-plugins";

const REPO_PLUGINS_DIRECTORY_NAME = "plugins";

export const BUILTIN_PLUGINS = [
  {
    name: "account-pool",
    pluginId: "account-pool",
    defaultEnabled: false,
  },
  {
    name: "ask-user-question",
    pluginId: "ask-user-question",
    defaultEnabled: false,
  },
  {
    name: "automations",
    pluginId: "automations",
    defaultEnabled: true,
  },
  {
    name: "connect",
    pluginId: "connect",
    defaultEnabled: true,
  },
  {
    name: "custom-instructions",
    pluginId: "custom-instructions",
    defaultEnabled: true,
  },
  {
    name: "plugin-api-tester",
    pluginId: "plugin-api-tester",
    defaultEnabled: false,
  },
  {
    name: "inline-vis",
    pluginId: "inline-vis",
    defaultEnabled: true,
  },
  {
    name: "monaco-editor",
    pluginId: "monaco-editor",
    defaultEnabled: false,
  },
  {
    name: "pdf-preview",
    pluginId: "pdf-preview",
    defaultEnabled: true,
  },
  {
    name: "provider-codex",
    pluginId: "provider-codex",
    defaultEnabled: true,
  },
  {
    name: "provider-claude-code",
    pluginId: "provider-claude-code",
    defaultEnabled: true,
  },
  {
    name: "provider-pi",
    pluginId: "provider-pi",
    defaultEnabled: true,
  },
  {
    name: "provider-usage",
    pluginId: "provider-usage",
    defaultEnabled: false,
  },
  {
    name: "provider-acp",
    pluginId: "provider-acp",
    defaultEnabled: true,
  },
  {
    name: "keep-awake",
    pluginId: "keep-awake",
    defaultEnabled: true,
  },
  {
    name: "plugin-api-docs",
    pluginId: "plugin-api-docs",
    defaultEnabled: false,
  },
  {
    name: "provider-retry",
    pluginId: "provider-retry",
    defaultEnabled: true,
  },
  {
    name: "push-notifications",
    pluginId: "push-notifications",
    defaultEnabled: true,
  },
  {
    name: "secrets",
    pluginId: "secrets",
    defaultEnabled: true,
  },
  {
    name: "scheduled-send",
    pluginId: "scheduled-send",
    defaultEnabled: true,
  },
  {
    name: "concurrency-limit",
    pluginId: "concurrency-limit",
    defaultEnabled: true,
  },
  {
    name: "side-chat",
    pluginId: "side-chat",
    defaultEnabled: true,
  },
  {
    name: "workflows",
    pluginId: "workflows",
    defaultEnabled: false,
  },
].map((plugin): BundledPluginDefinition => ({
  ...plugin,
  autoInstall: true,
}));

export const OFFICIAL_PLUGINS = [
  {
    name: "browser-automation",
    pluginId: "browser-automation",
    defaultEnabled: false,
  },
  {
    name: "github",
    pluginId: "github",
    defaultEnabled: true,
  },
  {
    name: "docs",
    pluginId: "simple-notes",
    defaultEnabled: true,
  },
  {
    name: "memory",
    pluginId: "memory",
    defaultEnabled: true,
  },
  {
    name: "tasks",
    pluginId: "tasks",
    defaultEnabled: true,
  },
  {
    name: "theme-preview",
    pluginId: "theme-preview",
    defaultEnabled: true,
  },
].map((plugin): BundledPluginDefinition => ({
  ...plugin,
  autoInstall: false,
}));

export const BUNDLED_PLUGINS: readonly BundledPluginDefinition[] = [
  ...BUILTIN_PLUGINS,
  ...OFFICIAL_PLUGINS,
];

export const BUILTIN_PLUGIN_NAMES = BUILTIN_PLUGINS.map(
  (plugin) => plugin.name,
);

const builtinPluginsModuleDir = path.dirname(fileURLToPath(import.meta.url));

export function builtinPluginSource(name: string): string {
  return `builtin:${name}`;
}

export function resolveBuiltinPluginRootPathForModuleDir(
  args: ResolveBuiltinPluginRootPathArgs,
): string {
  const packagedCandidate = path.resolve(
    args.moduleDir,
    BUILTIN_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
  if (existsSync(packagedCandidate)) return packagedCandidate;

  const builtCheckoutCandidate = path.resolve(
    args.moduleDir,
    "../../..",
    REPO_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
  if (existsSync(builtCheckoutCandidate)) return builtCheckoutCandidate;

  return path.resolve(
    args.moduleDir,
    "../../../../..",
    REPO_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
}

export function resolveBuiltinPluginRootPath(name: string): string {
  return resolveBuiltinPluginRootPathForModuleDir({
    moduleDir: builtinPluginsModuleDir,
    name,
  });
}

export function listBundledPluginRegistrations(): BundledPluginRegistration[] {
  return BUNDLED_PLUGINS.map((plugin) => ({
    ...plugin,
    rootDir: resolveBuiltinPluginRootPath(plugin.name),
  }));
}
