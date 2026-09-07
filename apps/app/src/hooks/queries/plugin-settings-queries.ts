import type {
  InstalledPlugin,
  PluginSettingDescriptor,
  PluginSettingsResponse,
} from "@bb/server-contract";
import { pluginSettingsUpdateRequestSchema } from "@bb/server-contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { createPluginsClient } from "./plugin-client";
import { pluginListQueryKey, pluginSettingsViewQueryKey } from "./query-keys";

type FetchLike = typeof fetch;

type PluginProvenance = InstalledPlugin["provenance"];

interface PluginUpdateFailure {
  version: string;
  at: number | null;
  detail: string;
}

export interface PluginUpdateState {
  outcome: InstalledPlugin["updateState"]["outcome"] | null;
  detail: string | null;
  availableVersion: string | null;
  blockedVersion: string | null;
  blockedReasons: string[];
  lastCheckAt: number | null;
  lastFailure: PluginUpdateFailure | null;
}

export interface PluginListItem {
  id: string;
  rootDir: string;
  version: string;
  enabled: boolean;
  status: InstalledPlugin["status"];
  statusDetail: string | null;
  description: string | null;
  name: string | null;
  icon: string | null;
  compactIconUrl: string | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  hasSettings: boolean;
  handlerStats: InstalledPlugin["handlerStats"];
  services: InstalledPlugin["services"];
  schedules: InstalledPlugin["schedules"];
  cliCommand: InstalledPlugin["cliCommand"];
  capabilities: InstalledPlugin["capabilities"];
  app: InstalledPlugin["app"];
  provenance: PluginProvenance;
  source: string;
  isOrphanedBuiltin: boolean;
  catalogEntryId: string | null;
  publisherLabel: string | null;
  sourceDisplay: string;
  updateState: PluginUpdateState;
}

export interface PluginListResult {
  plugins: PluginListItem[];
}

export function toEpochMs(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export const EMPTY_PLUGIN_UPDATE_STATE: PluginUpdateState = {
  outcome: null,
  detail: null,
  availableVersion: null,
  blockedVersion: null,
  blockedReasons: [],
  lastCheckAt: null,
  lastFailure: null,
};

export function toPluginListItem(plugin: InstalledPlugin): PluginListItem {
  const state = plugin.updateState;
  return {
    id: plugin.id,
    rootDir: plugin.rootDir,
    version: plugin.version,
    enabled: plugin.enabled,
    status: plugin.status,
    statusDetail: plugin.statusDetail,
    description: plugin.description,
    name: plugin.name,
    icon: plugin.icon,
    compactIconUrl: plugin.iconUrl,
    logoUrl: plugin.logoUrl,
    logoDarkUrl: plugin.logoDarkUrl,
    hasSettings: plugin.hasSettings,
    handlerStats: plugin.handlerStats,
    services: plugin.services,
    schedules: plugin.schedules,
    cliCommand: plugin.cliCommand,
    capabilities: plugin.capabilities,
    app: plugin.app,
    provenance: plugin.provenance,
    source: plugin.source,
    isOrphanedBuiltin: plugin.isOrphanedBuiltin,
    catalogEntryId: plugin.catalogEntryId ?? null,
    publisherLabel: plugin.publisherLabel,
    sourceDisplay: plugin.sourceDisplay,
    updateState: {
      outcome: state.outcome ?? null,
      detail: state.detail ?? null,
      availableVersion: state.availableVersion ?? null,
      blockedVersion: state.blockedVersion ?? null,
      blockedReasons: state.blockedReasons ?? [],
      lastCheckAt: toEpochMs(state.lastCheckAt),
      lastFailure:
        state.lastFailure === undefined
          ? null
          : {
              version: state.lastFailure.version,
              at: toEpochMs(state.lastFailure.at),
              detail: state.lastFailure.detail,
            },
    },
  };
}

export async function fetchPluginList(
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<PluginListResult> {
  const plugins = await fetchInstalledPlugins(fetchImpl, signal);
  return { plugins: plugins.map(toPluginListItem) };
}

export async function fetchInstalledPlugins(
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<InstalledPlugin[]> {
  return (await createPluginsClient(fetchImpl).list({ signal })).plugins;
}

export type PluginSettingFieldDescriptor = PluginSettingDescriptor;

export interface PluginSettingsView {
  schema: Record<string, PluginSettingFieldDescriptor>;
  values: PluginSettingsResponse["values"];
}

async function fetchPluginSettingsView(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<PluginSettingsView | null> {
  try {
    const result = await createPluginsClient(fetchImpl).getSettings({
      pluginId,
    });
    return { schema: result.schema, values: result.values };
  } catch {
    return null;
  }
}

export async function updatePluginSettings(
  fetchImpl: FetchLike,
  pluginId: string,
  values: Record<string, unknown>,
): Promise<PluginSettingsView> {
  const request = pluginSettingsUpdateRequestSchema.parse({ values });
  const result = await createPluginsClient(fetchImpl).updateSettings({
    pluginId,
    values: request.values,
  });
  return { schema: result.schema, values: result.values };
}

export async function setPluginEnabled(
  fetchImpl: FetchLike,
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  const plugins = createPluginsClient(fetchImpl);
  if (enabled) await plugins.enable({ pluginId });
  else await plugins.disable({ pluginId });
}

export async function reloadPlugin(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<void> {
  await createPluginsClient(fetchImpl).reload({ pluginId });
}

export async function removePlugin(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<void> {
  await createPluginsClient(fetchImpl).remove({ pluginId });
}

export function pluginListQueryOptions(args: { enabled: boolean }) {
  return queryOptions({
    queryKey: pluginListQueryKey(args.enabled),
    queryFn: ({ signal }) => fetchInstalledPlugins(fetch, signal),
    enabled: args.enabled,
    staleTime: 30_000,
  });
}

export function usePluginList(args: { enabled: boolean }) {
  return useQuery({
    ...pluginListQueryOptions(args),
    select: (plugins): PluginListResult => ({
      plugins: plugins.map(toPluginListItem),
    }),
  });
}

export function usePluginSettingsView(
  pluginId: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: pluginSettingsViewQueryKey(pluginId),
    queryFn: () => fetchPluginSettingsView(fetch, pluginId),
    enabled: options.enabled,
    staleTime: 30_000,
  });
}
