import type { QueryClient } from "@tanstack/react-query";
import {
  applyAppKeybindingOverrides,
  type AppKeybindingOverrides,
} from "@bb/domain";
import type { SystemConfigResponse } from "@bb/server-contract";
import { systemConfigQueryKey } from "../queries/query-keys";

interface KeyboardSettingsCacheTransaction {
  previous: SystemConfigResponse | undefined;
}

export function markSystemConfigStale(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    exact: true,
    queryKey: systemConfigQueryKey(),
    refetchType: "none",
  });
}

interface BeginKeyboardSettingsCacheTransactionArgs {
  overrides: AppKeybindingOverrides;
  queryClient: QueryClient;
}

export async function beginKeyboardSettingsCacheTransaction({
  overrides,
  queryClient,
}: BeginKeyboardSettingsCacheTransactionArgs): Promise<KeyboardSettingsCacheTransaction> {
  const queryKey = systemConfigQueryKey();
  await queryClient.cancelQueries({ queryKey });
  const previous = queryClient.getQueryData<SystemConfigResponse>(queryKey);
  if (previous !== undefined) {
    queryClient.setQueryData<SystemConfigResponse>(queryKey, {
      ...previous,
      keybindings: applyAppKeybindingOverrides(
        previous.defaultKeybindings,
        overrides,
      ),
      keybindingOverrides: overrides,
    });
  }
  return { previous };
}

interface RollbackKeyboardSettingsCacheTransactionArgs {
  queryClient: QueryClient;
  transaction: KeyboardSettingsCacheTransaction | undefined;
}

export function rollbackKeyboardSettingsCacheTransaction({
  queryClient,
  transaction,
}: RollbackKeyboardSettingsCacheTransactionArgs): void {
  if (transaction?.previous === undefined) return;
  queryClient.setQueryData(systemConfigQueryKey(), transaction.previous);
}

export function readCachedStreamerMode(
  queryClient: QueryClient,
): boolean | undefined {
  return queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey())
    ?.generalSettings.streamerMode;
}

export function readCachedProviderOrder(
  queryClient: QueryClient,
): readonly string[] | undefined {
  return queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey())
    ?.generalSettings.providerOrder;
}
