import { rejectMultipleWorkspaceSelectors } from "./shared.js";
import { z } from "zod";
import {
  appSettingsSchema,
  appDefaultKeybindingsSchema,
  appKeybindingOverridesSchema,
  appKeybindingsSchema,
  appThemeSchema,
  availableModelSchema,
  experimentsSchema,
  featureFlagsSchema,
  permissionModeSchema,
  pluginThemeMetaSchema,
  providerInfoSchema,
} from "@bb/domain";
import { providerHealthSchema as providerHealthSchema } from "@bb/provider-bridge-protocol/provider-maintenance";
import { hostPlatformSchema } from "@bb/host-daemon-contract/local";

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "provider_unavailable",
  "missing_executable",
  "auth_required",
  "timeout",
  "failed",
]);
export type SystemExecutionOptionsModelLoadErrorCode = z.infer<
  typeof systemExecutionOptionsModelLoadErrorCodeSchema
>;

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
});
export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  permissionCeiling: permissionModeSchema,
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
});
export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

export const systemProvidersQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    capability: z.enum(["usage"]),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const systemUsageLimitsQuerySchema = z.object({
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});
export type SystemUsageLimitsQuery = z.infer<
  typeof systemUsageLimitsQuerySchema
>;

export interface SystemVoiceTranscriptionForm {
  [key: string]: string | Blob;
}

export { providerInfoSchema as systemProviderInfoSchema } from "@bb/domain";
export type { ProviderInfo as SystemProviderInfo } from "@bb/domain";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

export const systemProviderStateSchema = providerHealthSchema.extend({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
});
export type SystemProviderState = z.infer<typeof systemProviderStateSchema>;

export const systemProviderStatesResponseSchema = z.object({
  providers: z.array(systemProviderStateSchema),
});
export type SystemProviderStatesResponse = z.infer<
  typeof systemProviderStatesResponseSchema
>;

export const systemAiServiceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kinds: z.array(z.enum(["inference", "voice"])),
  pluginId: z.string().min(1),
});
export type SystemAiService = z.infer<typeof systemAiServiceSchema>;

export const systemAiServicesSchema = z.object({
  inference: z.string().min(1),
  inferenceFallback: z.string().min(1),
  transcription: z.string().min(1),
  services: z.array(systemAiServiceSchema),
});
export type SystemAiServices = z.infer<typeof systemAiServicesSchema>;

export const systemConfigResponseSchema = z.object({
  generalSettings: appSettingsSchema,
  keybindings: appKeybindingsSchema,
  defaultKeybindings: appDefaultKeybindingsSchema,
  keybindingOverrides: appKeybindingOverridesSchema,
  experiments: experimentsSchema,
  appearance: appThemeSchema,
  customThemes: z.array(z.string()),
  pluginThemes: z.array(pluginThemeMetaSchema),
  featureFlags: featureFlagsSchema,
  hostDaemonPort: z.number().nullable(),
  localHelperPorts: z.array(z.number().int().min(1).max(65_535)),
  serverUrl: z.string().url(),
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: hostPlatformSchema.nullable(),
  voiceTranscriptionEnabled: z.boolean(),
  aiServices: systemAiServicesSchema,
  dataDir: z.string(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemAttentionResponseSchema = z.object({
  hasAttention: z.boolean(),
});
export type SystemAttentionResponse = z.infer<
  typeof systemAttentionResponseSchema
>;

export const themeCatalogResponseSchema = z.object({
  dir: z.string(),
  custom: z.array(z.string()),
  plugins: z.array(pluginThemeMetaSchema),
  active: appThemeSchema,
});
export type ThemeCatalogResponse = z.infer<typeof themeCatalogResponseSchema>;

export const systemVersionResponseSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  source: z.literal("npm"),
  updateAvailable: z.boolean(),
  isDevelopment: z.boolean(),
  upgradeCommand: z.string(),
});
export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

export const systemVersionQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
});
export type SystemVersionQuery = z.infer<typeof systemVersionQuerySchema>;

export const systemConfigReloadResponseSchema = z.object({
  ok: z.literal(true),
});

export const cliSkillMachineStatusSchema = z.enum([
  "installed",
  "outdated",
  "missing",
  "unknown",
]);
export type CliSkillMachineStatus = z.infer<typeof cliSkillMachineStatusSchema>;

export const systemCliSkillsStatusQuerySchema = z.object({
  hostIds: z.string().optional(),
});
export type SystemCliSkillsStatusQuery = z.infer<
  typeof systemCliSkillsStatusQuerySchema
>;

export const systemCliSkillsStatusResponseSchema = z.object({
  machines: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      status: cliSkillMachineStatusSchema,
    }),
  ),
});
export type SystemCliSkillsStatusResponse = z.infer<
  typeof systemCliSkillsStatusResponseSchema
>;

export const systemInstallCliSkillsRequestSchema = z.object({
  hostIds: z.array(z.string().min(1)).min(1).max(64),
});
export type SystemInstallCliSkillsRequest = z.infer<
  typeof systemInstallCliSkillsRequestSchema
>;

export const systemInstallCliSkillsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        hostId: z.string(),
        hostName: z.string(),
        installations: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        hostId: z.string(),
        hostName: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
});
export type SystemInstallCliSkillsResponse = z.infer<
  typeof systemInstallCliSkillsResponseSchema
>;
export type SystemConfigReloadResponse = z.infer<
  typeof systemConfigReloadResponseSchema
>;
