import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_aiServicesHostContract,
  type ExperimentalAiInferenceCompleteOutput,
  type ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import {
  completeCodexInference,
  transcribeCodexVoice,
} from "./ai/chatgpt-client.js";
import { toAiServiceFailure } from "./ai/failure.js";
import { resolveCodexNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export const CODEX_AI_SERVICE_ID = "codex";

const codexHostContract = defineRpcContract({
  ...experimental_aiServicesHostContract,
  ...experimental_nativeRootsHostContract,
});

export default experimental_defineHostEntry({
  contract: codexHostContract,
  handlers: {
    resolveNativeRoots: (): Promise<ExperimentalNativeRootsResolveAnswer> =>
      resolveCodexNativeRoots({ homeDir: os.homedir(), env: process.env }),
    "ai.inference.complete": async (
      input,
    ): Promise<ExperimentalAiInferenceCompleteOutput> => {
      if (input.serviceId !== CODEX_AI_SERVICE_ID) {
        return {
          ok: false,
          code: "request_failed",
          message: `This plugin serves no AI service "${input.serviceId}".`,
        };
      }
      try {
        return await completeCodexInference(input);
      } catch (error) {
        return toAiServiceFailure(error);
      }
    },
    "ai.voice.transcribe": async (
      input,
    ): Promise<ExperimentalAiVoiceTranscribeOutput> => {
      if (input.serviceId !== CODEX_AI_SERVICE_ID) {
        return {
          ok: false,
          code: "request_failed",
          message: `This plugin serves no AI service "${input.serviceId}".`,
        };
      }
      try {
        return await transcribeCodexVoice(input);
      } catch (error) {
        return toAiServiceFailure(error);
      }
    },
  },
});
