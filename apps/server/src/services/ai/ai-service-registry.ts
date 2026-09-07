import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type {
  PluginAiServiceDeclaration,
  PluginAiServiceKind,
} from "@get-bb/plugin-sdk";
import { aiServiceAlreadyRegisteredMessage } from "@get-bb/plugin-sdk/internal/host-policy";

export interface AiServiceCallOptions {
  hostId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AiServiceRegistration extends PluginAiServiceDeclaration {
  pluginId: string;
  completeInference(
    input: ExperimentalAiInferenceCompleteInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiInferenceCompleteOutput>;
  transcribeVoice(
    input: ExperimentalAiVoiceTranscribeInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceTranscribeOutput>;
}

export interface AiServiceInfo extends PluginAiServiceDeclaration {
  pluginId: string;
}

export interface AiServiceRegistry {
  register(registration: AiServiceRegistration): { dispose(): void };
  get(id: string): AiServiceRegistration | null;
  serves(id: string, kind: PluginAiServiceKind): boolean;
  list(): AiServiceInfo[];
}

export function createAiServiceRegistry(): AiServiceRegistry {
  const services = new Map<string, AiServiceRegistration>();
  return {
    register(registration) {
      if (services.has(registration.id)) {
        throw new Error(aiServiceAlreadyRegisteredMessage(registration.id));
      }
      services.set(registration.id, registration);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (services.get(registration.id) === registration) {
            services.delete(registration.id);
          }
        },
      };
    },
    get(id) {
      return services.get(id) ?? null;
    },
    serves(id, kind) {
      return services.get(id)?.kinds.includes(kind) ?? false;
    },
    list() {
      return [...services.values()].map((service) => ({
        id: service.id,
        displayName: service.displayName,
        kinds: service.kinds,
        pluginId: service.pluginId,
      }));
    },
  };
}
