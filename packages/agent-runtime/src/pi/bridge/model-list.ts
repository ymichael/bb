import type { AvailableModel } from "@bb/domain";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { buildPiAvailableModels } from "../model-list.js";

export interface ListPiBridgeModelsArgs {
  selectedModel?: string;
}

export async function listPiBridgeModels(
  args: ListPiBridgeModelsArgs = {},
): Promise<AvailableModel[]> {
  const [piAiModule, piCodingAgentModule] = await Promise.all([
    import("@mariozechner/pi-ai"),
    import("@mariozechner/pi-coding-agent"),
  ]);

  const authStorage = piCodingAgentModule.AuthStorage.create();
  const providers = piAiModule.getProviders();

  return buildPiAvailableModels({
    providers,
    getModels(provider: KnownProvider) {
      return piAiModule.getModels(provider).map((model) => ({
        id: model.id,
        input: model.input,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
        supportsXhigh: piAiModule.supportsXhigh(model),
      }));
    },
    hasAuth(provider: KnownProvider) {
      return authStorage.hasAuth(provider);
    },
    selectedModel: args.selectedModel,
  });
}
