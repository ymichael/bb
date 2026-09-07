import { Buffer } from "node:buffer";
import { jsonValueSchema, type JsonObject, type JsonValue } from "@bb/domain";
import {
  parseProviderModelConfig,
  type ProviderModelInfo,
} from "@bb/config/inference-model";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { AiServiceCallError } from "./ai-service-call.js";
import type { AiServiceRegistration } from "./ai-service-registry.js";
import {
  INFERENCE_POLICY,
  inferenceCompleteWithFallback,
} from "./inference.js";
import { Type } from "@earendil-works/pi-ai";

interface TranscribeVoiceInputArgs {
  file: File;
  prompt?: string;
}

type OptionalJsonValue = JsonValue | null | undefined;

const OPENAI_TRANSCRIPTION_PROVIDER = "openai";
const VOICE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
const AI_SERVICE_VOICE_MAX_BYTES = 5 * 1024 * 1024;
const voiceTranscriptionSchema = Type.Object({ text: Type.String() });

function parseTranscriptionModel(model: string): ProviderModelInfo {
  return parseProviderModelConfig({
    name: "BB_TRANSCRIPTION",
    value: model,
  });
}

function voiceService(
  deps: LoggedWorkSessionDeps,
  modelInfo: ProviderModelInfo,
): AiServiceRegistration | null {
  const service = deps.aiServices.get(modelInfo.provider);
  return service !== null && service.kinds.includes("voice") ? service : null;
}

function isPrimaryHostConnected(deps: LoggedWorkSessionDeps): boolean {
  try {
    requireConnectedPrimaryHostId(deps);
    return true;
  } catch {
    return false;
  }
}

export function resolveVoiceTranscriptionEnabled(
  deps: LoggedWorkSessionDeps,
): boolean {
  const modelInfo = parseTranscriptionModel(deps.config.transcriptionModel);
  if (modelInfo.provider === OPENAI_TRANSCRIPTION_PROVIDER) {
    return deps.config.openAiApiKey.length > 0;
  }
  if (voiceService(deps, modelInfo) !== null) {
    return isPrimaryHostConnected(deps);
  }
  return false;
}

function trimPrompt(prompt: string | undefined): string | null {
  const trimmed = prompt?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function jsonObjectFromValue(value: OptionalJsonValue): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function jsonStringProperty(
  value: OptionalJsonValue,
  propertyName: string,
): string | null {
  const object = jsonObjectFromValue(value);
  const propertyValue = object?.[propertyName];
  return typeof propertyValue === "string" ? propertyValue : null;
}

function openAiErrorMessage(payload: OptionalJsonValue): string {
  const object = jsonObjectFromValue(payload);
  const error = object?.error;
  return jsonStringProperty(error, "message") ?? "Voice transcription failed";
}

async function readJsonValue(response: Response): Promise<JsonValue | null> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function buildTranscriptionTimeoutError(): ApiError {
  return new ApiError(
    504,
    "transcription_timeout",
    "Voice transcription timed out",
    true,
  );
}

function buildTranscriptionUnavailableError(): ApiError {
  return new ApiError(
    503,
    "transcription_unavailable",
    "Voice transcription is temporarily unavailable. Please try again in a moment.",
    true,
  );
}

async function transcribeWithAiService(
  deps: LoggedWorkSessionDeps,
  service: AiServiceRegistration,
  modelInfo: ProviderModelInfo,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  if (args.file.size > AI_SERVICE_VOICE_MAX_BYTES) {
    throw new ApiError(
      400,
      "invalid_request",
      `Audio file exceeds the ${AI_SERVICE_VOICE_MAX_BYTES / (1024 * 1024)}MB limit for plugin-served transcription`,
    );
  }
  const hostId = requireConnectedPrimaryHostId(deps);
  const audioBase64 = Buffer.from(await args.file.arrayBuffer()).toString(
    "base64",
  );
  const prompt = trimPrompt(args.prompt) ?? "";
  const transcriptionModel = `${modelInfo.provider}/${modelInfo.modelId}`;
  const transcription = await inferenceCompleteWithFallback(deps, {
    ...INFERENCE_POLICY.voiceTranscription,
    complete: async (model, attemptPrompt, timeoutMs) => {
      const attemptModel = parseTranscriptionModel(model);
      const result = await service.transcribeVoice(
        {
          serviceId: service.id,
          model: attemptModel.modelId,
          audioBase64,
          mimeType: args.file.type || "application/octet-stream",
          filename: args.file.name || "voice-input",
          prompt: trimPrompt(attemptPrompt),
          timeoutMs,
        },
        { hostId, timeoutMs: timeoutMs + INFERENCE_POLICY.hostRpcGraceMs },
      );
      if (!result.ok) {
        throw new AiServiceCallError(service.id, result.code, result.message);
      }
      return { text: result.text };
    },
    fallbackModel: transcriptionModel,
    label: "Voice transcription",
    primaryModel: transcriptionModel,
    prompt,
    schema: voiceTranscriptionSchema,
  }).catch((error: Error) => error);
  if (!(transcription instanceof Error) && transcription) {
    return transcription.text;
  }
  if (!(transcription instanceof Error)) {
    throw buildTranscriptionUnavailableError();
  }
  if (
    (transcription instanceof AiServiceCallError &&
      transcription.code === "timeout") ||
    (transcription instanceof ApiError &&
      transcription.body.code === "command_timeout")
  ) {
    throw buildTranscriptionTimeoutError();
  }
  if (
    transcription instanceof AiServiceCallError &&
    (transcription.code === "rate_limited" ||
      transcription.code === "service_unavailable")
  ) {
    throw buildTranscriptionUnavailableError();
  }
  throw transcription;
}

async function transcribeWithOpenAi(
  deps: LoggedWorkSessionDeps,
  modelInfo: ProviderModelInfo,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  if (!deps.config.openAiApiKey) {
    throw new ApiError(
      501,
      "not_configured",
      "Voice transcription requires OPENAI_API_KEY for openai/* transcription",
    );
  }

  const formData = new FormData();
  formData.set("model", modelInfo.modelId);
  formData.set("file", args.file, args.file.name);
  const prompt = trimPrompt(args.prompt);
  if (prompt) {
    formData.set("prompt", prompt);
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, INFERENCE_POLICY.voiceTranscription.timeoutMs);
  timer.unref();

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.config.openAiApiKey}`,
      },
      body: formData,
      signal: abortController.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw buildTranscriptionTimeoutError();
    }
    deps.logger.warn(
      runtimeErrorLogFields(deps.config, error),
      "OpenAI voice transcription request failed",
    );
    throw new ApiError(
      502,
      "provider_rpc_error",
      "Voice transcription request failed",
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = await readJsonValue(response);
  if (!response.ok) {
    throw new ApiError(502, "provider_rpc_error", openAiErrorMessage(payload));
  }

  const text = jsonStringProperty(payload, "text");
  if (!text) {
    throw new ApiError(502, "provider_rpc_error", "Voice transcription failed");
  }

  return text;
}

export async function transcribeVoiceInput(
  deps: LoggedWorkSessionDeps,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  if (args.file.size === 0) {
    throw new ApiError(400, "invalid_request", "Audio file must not be empty");
  }
  if (args.file.size > VOICE_TRANSCRIPTION_MAX_BYTES) {
    throw new ApiError(400, "invalid_request", "Audio file exceeds 25MB limit");
  }

  const modelInfo = parseTranscriptionModel(deps.config.transcriptionModel);
  if (modelInfo.provider === OPENAI_TRANSCRIPTION_PROVIDER) {
    return transcribeWithOpenAi(deps, modelInfo, args);
  }
  const service = voiceService(deps, modelInfo);
  if (service !== null) {
    return transcribeWithAiService(deps, service, modelInfo, args);
  }

  throw new ApiError(
    501,
    "not_configured",
    `No loaded plugin registers AI service "${modelInfo.provider}" for voice transcription`,
  );
}
