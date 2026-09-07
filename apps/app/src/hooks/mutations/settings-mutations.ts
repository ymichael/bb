import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type AppKeybindingOverrides,
  type AppSettings,
  type AppThemeSelection,
  type Experiments,
} from "@bb/domain";
import type { SystemInstallCliSkillsRequest } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  invalidateGeneralSettingsDependencies,
  invalidateSystemConfig,
  invalidateSystemProviders,
  resetModelCatalogsAfterStreamerModeChange,
} from "../cache-owners/system-cache-effects";
import {
  beginKeyboardSettingsCacheTransaction,
  readCachedProviderOrder,
  readCachedStreamerMode,
  rollbackKeyboardSettingsCacheTransaction,
} from "../cache-owners/system-config-cache-owner";

export function useUpdateExperiments() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update experiments.",
    },
    mutationFn: (experiments: Experiments) =>
      sdk.system.updateExperiments(experiments),
    onSuccess: () => {
      invalidateSystemConfig({ queryClient });
    },
  });
}

export function useUpdateGeneralSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update general settings.",
    },
    mutationFn: (settings: AppSettings) =>
      sdk.system.updateGeneralSettings(settings),
    onSuccess: (_settings, written) => {
      const previousStreamerMode = readCachedStreamerMode(queryClient);
      const previousProviderOrder = readCachedProviderOrder(queryClient);
      invalidateGeneralSettingsDependencies({ queryClient });
      if (previousStreamerMode !== written.streamerMode) {
        void resetModelCatalogsAfterStreamerModeChange({ queryClient });
      }
      const providerOrderChanged =
        previousProviderOrder === undefined ||
        previousProviderOrder.length !== written.providerOrder.length ||
        previousProviderOrder.some(
          (providerId, index) => providerId !== written.providerOrder[index],
        );
      if (providerOrderChanged) {
        return invalidateSystemProviders({ queryClient });
      }
    },
  });
}

export function useUpdateKeyboardSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update keyboard shortcuts.",
    },
    mutationFn: (overrides: AppKeybindingOverrides) =>
      sdk.system.updateKeyboardSettings(overrides),
    onMutate: (overrides) =>
      beginKeyboardSettingsCacheTransaction({ overrides, queryClient }),
    onError: (_error, _overrides, context) => {
      rollbackKeyboardSettingsCacheTransaction({
        queryClient,
        transaction: context,
      });
    },
    onSuccess: () => {
      invalidateSystemConfig({ queryClient });
    },
  });
}

export function useInstallCliSkills() {
  return useMutation({
    meta: {
      errorMessage: "Failed to install the bb CLI skills.",
    },
    mutationFn: (args: SystemInstallCliSkillsRequest) =>
      sdk.system.installCliSkills(args),
  });
}

export function useUpdateAppearance() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update appearance.",
    },
    mutationFn: (selection: AppThemeSelection) => sdk.theme.set(selection),
    onSuccess: () => {
      invalidateSystemConfig({ queryClient });
    },
  });
}
