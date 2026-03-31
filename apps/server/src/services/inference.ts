import { complete, getModel } from "@mariozechner/pi-ai";
import type { AppDeps } from "../types.js";

export interface InferenceModelInfo {
  provider: string;
  modelId: string;
}

export function parseInferenceModel(model: string): InferenceModelInfo {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(`Invalid inference model: ${model}`);
  }
  return {
    provider: model.slice(0, slashIndex),
    modelId: model.slice(slashIndex + 1),
  };
}

export function extractAssistantText(
  message: Awaited<ReturnType<typeof complete>>,
): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function getInferenceModel(
  deps: Pick<AppDeps, "config" | "logger">,
): ReturnType<typeof getModel> | null {
  const modelInfo = parseInferenceModel(deps.config.inferenceModel);
  if (modelInfo.provider === "openai" && !deps.config.openAiApiKey) {
    return null;
  }
  // @ts-expect-error — pi-ai overloads getModel per provider; our provider string is dynamic
  const model = getModel(modelInfo.provider, modelInfo.modelId);
  if (!model) {
    deps.logger.warn(
      { provider: modelInfo.provider },
      "Unsupported inference provider",
    );
    return null;
  }
  return model;
}
