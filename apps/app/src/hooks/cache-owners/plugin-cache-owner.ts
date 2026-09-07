import type { QueryClient } from "@tanstack/react-query";
import {
  pluginListQueryOptions,
  type PluginSettingsView,
} from "../queries/plugin-settings-queries";
import type { InstalledPlugin } from "@bb/server-contract";
import {
  allPluginCatalogSearchQueryKeyPrefix,
  allPluginListQueryKeyPrefix,
  pluginListQueryKey,
  pluginMarketplacesQueryKey,
  pluginSettingsViewQueryKey,
} from "../queries/query-keys";

export function applyPluginSettingsView(args: {
  queryClient: QueryClient;
  pluginId: string;
  view: PluginSettingsView;
}): void {
  args.queryClient.setQueryData(
    pluginSettingsViewQueryKey(args.pluginId),
    args.view,
  );
}

export function applyInstalledPlugin(args: {
  queryClient: QueryClient;
  plugin: InstalledPlugin;
}): void {
  args.queryClient.setQueryData<InstalledPlugin[]>(
    pluginListQueryKey(true),
    (current) => {
      const plugins = current ?? [];
      const existingIndex = plugins.findIndex(
        (candidate) => candidate.id === args.plugin.id,
      );
      if (existingIndex === -1) {
        return [...plugins, args.plugin];
      }
      return plugins.map((candidate, index) =>
        index === existingIndex ? args.plugin : candidate,
      );
    },
  );
}

export function invalidatePluginList(args: {
  queryClient: QueryClient;
}): Promise<void> {
  return args.queryClient.invalidateQueries({
    queryKey: allPluginListQueryKeyPrefix(),
  });
}

export async function markEnabledPluginListStale(args: {
  queryClient: QueryClient;
}): Promise<void> {
  const queryKey = pluginListQueryKey(true);
  if (args.queryClient.getQueryState(queryKey)?.fetchStatus === "fetching") {
    try {
      await args.queryClient.fetchQuery(
        pluginListQueryOptions({ enabled: true }),
      );
    } catch {}
  }
  await args.queryClient.invalidateQueries({
    exact: true,
    queryKey,
    refetchType: "none",
  });
}

export function invalidatePluginCatalogSearch(args: {
  queryClient: QueryClient;
}): void {
  void args.queryClient.invalidateQueries({
    queryKey: allPluginCatalogSearchQueryKeyPrefix(),
  });
}

export function invalidatePluginMarketplaces(args: {
  queryClient: QueryClient;
}): void {
  void args.queryClient.invalidateQueries({
    queryKey: pluginMarketplacesQueryKey(),
  });
  invalidatePluginCatalogSearch(args);
}
