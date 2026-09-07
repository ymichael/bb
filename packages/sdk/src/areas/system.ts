import type {
  AppKeybindingOverrides,
  AppSettings,
  Experiments,
} from "@bb/domain";
import type { ProviderUsageResponse } from "@bb/host-daemon-contract";
import type {
  SystemAttentionResponse,
  SystemConfigReloadResponse,
  SystemConfigResponse,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemCliSkillsStatusResponse,
  SystemInstallCliSkillsRequest,
  SystemInstallCliSkillsResponse,
  SystemProviderStatesResponse,
  SystemProvidersQuery,
  SystemUsageLimitsQuery,
  SystemVersionQuery,
  SystemVersionResponse,
  SystemVoiceTranscriptionResponse,
} from "@bb/server-contract";
import { systemVoiceTranscriptionResponseSchema } from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SystemAttentionArgs {
  signal?: AbortSignal;
}

export interface SystemConfigArgs {
  signal?: AbortSignal;
}

export interface SystemExecutionOptionsArgs extends SystemExecutionOptionsQuery {
  signal?: AbortSignal;
}

export interface SystemUsageLimitsArgs extends SystemUsageLimitsQuery {
  signal?: AbortSignal;
}

export interface SystemVersionArgs {
  force?: boolean;
  signal?: AbortSignal;
}

export interface SystemVoiceTranscriptionArgs {
  file: Blob;
  prompt?: string;
  signal?: AbortSignal;
}

export type SystemAttentionResult = SystemAttentionResponse;
export type SystemConfigResult = SystemConfigResponse;
export type SystemExecutionOptionsResult = SystemExecutionOptionsResponse;
export type SystemReloadConfigResult = SystemConfigReloadResponse;
export type SystemInstallCliSkillsArgs = SystemInstallCliSkillsRequest;
export interface SystemCliSkillsStatusArgs {
  hostIds?: readonly string[];
  signal?: AbortSignal;
}
export type SystemCliSkillsStatusResult = SystemCliSkillsStatusResponse;
export type SystemInstallCliSkillsResult = SystemInstallCliSkillsResponse;
export type SystemVoiceTranscriptionResult = SystemVoiceTranscriptionResponse;
export type SystemUpdateExperimentsResult = Experiments;
export type SystemUpdateGeneralSettingsResult = AppSettings;
export type SystemUpdateKeyboardSettingsResult = AppKeybindingOverrides;
export type SystemUsageLimitsResult = ProviderUsageResponse;
export interface SystemProviderStatesArgs extends SystemProvidersQuery {
  signal?: AbortSignal;
}
export type SystemProviderStatesResult = SystemProviderStatesResponse;
export type SystemVersionResult = SystemVersionResponse;

export interface SystemArea {
  attention(args?: SystemAttentionArgs): Promise<SystemAttentionResult>;
  config(args?: SystemConfigArgs): Promise<SystemConfigResult>;
  executionOptions(
    args?: SystemExecutionOptionsArgs,
  ): Promise<SystemExecutionOptionsResult>;
  cliSkillsStatus(
    args?: SystemCliSkillsStatusArgs,
  ): Promise<SystemCliSkillsStatusResult>;
  installCliSkills(
    args: SystemInstallCliSkillsArgs,
  ): Promise<SystemInstallCliSkillsResult>;
  reloadConfig(): Promise<SystemReloadConfigResult>;
  transcribeVoice(
    args: SystemVoiceTranscriptionArgs,
  ): Promise<SystemVoiceTranscriptionResult>;
  updateExperiments(args: Experiments): Promise<SystemUpdateExperimentsResult>;
  updateGeneralSettings(
    args: AppSettings,
  ): Promise<SystemUpdateGeneralSettingsResult>;
  updateKeyboardSettings(
    args: AppKeybindingOverrides,
  ): Promise<SystemUpdateKeyboardSettingsResult>;
  providerStates(
    args?: SystemProviderStatesArgs,
  ): Promise<SystemProviderStatesResult>;
  usageLimits(args?: SystemUsageLimitsArgs): Promise<SystemUsageLimitsResult>;
  version(args?: SystemVersionArgs): Promise<SystemVersionResult>;
}

function versionQuery(args: SystemVersionArgs | undefined): SystemVersionQuery {
  return args?.force === undefined
    ? {}
    : { force: args.force ? "true" : "false" };
}

export function createSystemArea(args: CreateSdkAreaArgs): SystemArea {
  const { transport } = args;
  return {
    async attention(input) {
      return transport.readJson(
        transport.api.v1.system.attention.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async config(input) {
      return transport.readJson(
        transport.api.v1.system.config.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async executionOptions(input = {}) {
      return transport.readJson(
        transport.api.v1.system["execution-options"].$get(
          {
            query: {
              environmentId: input.environmentId,
              hostId: input.hostId,
              providerId: input.providerId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async cliSkillsStatus(input = {}) {
      return transport.readJson(
        transport.api.v1.system["cli-skills"].$get(
          {
            query:
              input.hostIds === undefined
                ? {}
                : { hostIds: input.hostIds.join(",") },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async installCliSkills(input) {
      return transport.readJson(
        transport.api.v1.system["cli-skills"].install.$post({ json: input }),
      );
    },
    async reloadConfig() {
      return transport.readJson(transport.api.v1.system.config.reload.$post());
    },
    async transcribeVoice(input) {
      if (input.file.size === 0) {
        throw new Error("Audio file must not be empty");
      }
      const form = new FormData();
      form.set("file", input.file);
      if (input.prompt !== undefined) form.set("prompt", input.prompt);
      const baseUrl = transport.baseUrl.replace(/\/$/u, "");
      const response = await transport.resolve(
        transport.fetch(`${baseUrl}/api/v1/system/voice-transcription`, {
          method: "POST",
          body: form,
          signal: input.signal,
        }),
      );
      return systemVoiceTranscriptionResponseSchema.parse(
        await response.json(),
      );
    },
    async updateExperiments(input) {
      return transport.readJson(
        transport.api.v1.settings.experiments.$put({ json: input }),
      );
    },
    async updateGeneralSettings(input) {
      return transport.readJson(
        transport.api.v1.settings.general.$put({ json: input }),
      );
    },
    async updateKeyboardSettings(input) {
      return transport.readJson(
        transport.api.v1.settings.keyboard.$put({ json: input }),
      );
    },
    async providerStates(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.state.$get(
          {
            query: {
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async usageLimits(input = {}) {
      return transport.readJson(
        transport.api.v1.system["usage-limits"].$get(
          {
            query: {
              hostId: input.hostId,
              providerId: input.providerId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async version(input) {
      return transport.readJson(
        transport.api.v1.system.version.$get(
          { query: versionQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
  };
}
