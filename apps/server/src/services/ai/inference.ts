import { setTimeout as delay } from "node:timers/promises";
import { SERVER_DIRECT_AI_SERVICE_IDS } from "@get-bb/plugin-sdk/internal/host-policy";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "@bb/domain";
import {
  parseProviderModelConfig,
  type ProviderModelInfo,
} from "@bb/config/inference-model";
import { validateToolCall } from "@earendil-works/pi-ai";
import type { Static, TSchema, Tool, ToolCall } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import {
  AI_SERVICE_ERROR_CODES,
  AiServiceCallError,
  isTransientAiServiceError,
} from "./ai-service-call.js";

type BaseInferenceDeps = Pick<AppDeps, "config" | "logger">;

type InferenceModels = ReturnType<typeof builtinModels>;

let inferenceModelsInstance: InferenceModels | undefined;

function getInferenceModels(): InferenceModels {
  inferenceModelsInstance ??= builtinModels();
  return inferenceModelsInstance;
}

export function isServerDirectAiServiceId(id: string): boolean {
  return SERVER_DIRECT_AI_SERVICE_IDS.includes(id);
}

function getInferenceModel(
  deps: BaseInferenceDeps,
  modelInfo: ProviderModelInfo,
): ReturnType<InferenceModels["getModel"]> | null {
  const model = getInferenceModels().getModel(
    modelInfo.provider,
    modelInfo.modelId,
  );
  if (!model) {
    deps.logger.warn(
      { provider: modelInfo.provider },
      "Unsupported inference provider",
    );
    return null;
  }
  return model;
}

const RESULT_TOOL_NAME = "result";
const DEFAULT_INFERENCE_TIMEOUT_MS = 30_000;

export const INFERENCE_POLICY = {
  hostRpcGraceMs: 1_000,
  commitMessage: { maxAttempts: 2, retryDelayMs: 0, timeoutMs: 5_000 },
  threadMetadata: { maxAttempts: 2, retryDelayMs: 250, timeoutMs: 5_000 },
  voiceTranscription: { maxAttempts: 2, retryDelayMs: 250, timeoutMs: 10_000 },
} as const;

interface InferenceCompleteArgs<T extends TSchema> {
  model?: string;
  prompt: string;
  schema: T;
  timeoutMs?: number;
}

interface InferenceTimeoutErrorArgs {
  timeoutMs: number;
}

export class InferenceTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(args: InferenceTimeoutErrorArgs) {
    super(`Inference request timed out after ${args.timeoutMs}ms`);
    this.name = "InferenceTimeoutError";
    this.timeoutMs = args.timeoutMs;
  }
}

function toToolCallArguments(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Structured inference result must be a JSON object");
  }
  return value;
}

function validateStructuredResult<T extends TSchema>(
  schema: T,
  value: JsonValue,
): Static<T> {
  const tools: Tool<T>[] = [
    {
      name: RESULT_TOOL_NAME,
      description: "Return the result as structured JSON.",
      parameters: schema,
    },
  ];
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "codex_result",
    name: RESULT_TOOL_NAME,
    arguments: toToolCallArguments(value),
  };

  return validateToolCall(tools, toolCall) as Static<T>;
}

function isTransientInferenceError(error: Error): boolean {
  return (
    error instanceof InferenceTimeoutError || isTransientAiServiceError(error)
  );
}

interface InferenceCompleteWithFallbackArgs<T extends TSchema> {
  complete?: (
    model: string,
    prompt: string,
    timeoutMs: number,
  ) => Promise<Static<T> | null>;
  fallbackModel?: string;
  label: string;
  logContext?: JsonObject;
  maxAttempts: number;
  primaryModel?: string;
  prompt: string;
  retryDelayMs: number;
  schema: T;
  timeoutMs: number;
}

export async function inferenceCompleteWithFallback<T extends TSchema>(
  deps: LoggedWorkSessionDeps,
  args: InferenceCompleteWithFallbackArgs<T>,
): Promise<Static<T> | null> {
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, args.maxAttempts);
  const primaryModel = args.primaryModel ?? deps.config.inferenceModel;
  const fallbackModel =
    args.fallbackModel ?? deps.config.inferenceFallbackModel;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const model = attempt === 1 ? primaryModel : fallbackModel;
    try {
      const value = args.complete
        ? await args.complete(model, args.prompt, args.timeoutMs)
        : await inferenceComplete(deps, {
            model,
            prompt: args.prompt,
            schema: args.schema,
            timeoutMs: args.timeoutMs,
          });
      if (attempt > 1) {
        deps.logger.info(
          {
            attempts: attempt,
            durationMs: Date.now() - startedAt,
            maxAttempts,
            model,
            reason: "transient-failure",
            timeoutMs: args.timeoutMs,
            ...args.logContext,
          },
          `${args.label} completed with fallback model`,
        );
      }
      if (value === null) {
        deps.logger.warn(
          {
            attempts: attempt,
            durationMs: Date.now() - startedAt,
            reason: "no-result",
            ...args.logContext,
          },
          `${args.label} returned no result`,
        );
      }
      return value;
    } catch (error) {
      const err =
        error instanceof Error
          ? error
          : new Error(`Non-Error thrown during ${args.label.toLowerCase()}`);
      const transient = isTransientInferenceError(err);
      if (transient && attempt < maxAttempts) {
        deps.logger.info(
          {
            attempt,
            errorCode:
              err instanceof ApiError
                ? err.body.code
                : err instanceof AiServiceCallError
                  ? AI_SERVICE_ERROR_CODES[err.code]
                  : "timeout",
            fallbackModel,
            maxAttempts,
            model,
            reason: "transient-failure",
            ...(err instanceof InferenceTimeoutError
              ? { timeoutMs: err.timeoutMs }
              : {}),
            ...args.logContext,
          },
          `${args.label} failed transiently; using fallback model`,
        );
        if (args.retryDelayMs > 0) {
          await delay(args.retryDelayMs);
        }
        continue;
      }
      const fields = {
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        maxAttempts,
        model,
        ...args.logContext,
      };
      if (err instanceof InferenceTimeoutError) {
        deps.logger.info(
          { ...fields, reason: "timeout", timeoutMs: err.timeoutMs },
          `${args.label} timed out`,
        );
      } else {
        deps.logger.warn(
          {
            ...fields,
            ...runtimeErrorLogFields(deps.config, err),
            reason: "failed",
          },
          `${args.label} failed`,
        );
      }
      throw err;
    }
  }

  throw new Error("Inference fallback loop completed without an outcome");
}

async function completeWithAiService<T extends TSchema>(
  deps: LoggedWorkSessionDeps,
  modelInfo: ProviderModelInfo,
  args: InferenceCompleteArgs<T>,
): Promise<Static<T> | null> {
  const service = deps.aiServices.get(modelInfo.provider);
  if (service === null || !service.kinds.includes("inference")) {
    throw new ApiError(
      501,
      "not_configured",
      `No loaded plugin registers AI service "${modelInfo.provider}" for inference`,
    );
  }
  const hostId = requireConnectedPrimaryHostId(deps);
  const timeoutMs = args.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
  const result = await service.completeInference(
    {
      serviceId: service.id,
      model: modelInfo.modelId,
      reasoningEffort: "none",
      prompt: args.prompt,
      outputSchema: jsonObjectSchema.parse(args.schema),
      timeoutMs,
    },
    { hostId, timeoutMs: timeoutMs + INFERENCE_POLICY.hostRpcGraceMs },
  );
  if (!result.ok) {
    if (result.code === "timeout") {
      throw new InferenceTimeoutError({ timeoutMs });
    }
    throw new AiServiceCallError(service.id, result.code, result.message);
  }
  return validateStructuredResult(
    args.schema,
    jsonObjectSchema.parse(result.value),
  );
}

export async function inferenceComplete<T extends TSchema>(
  deps: LoggedWorkSessionDeps,
  args: InferenceCompleteArgs<T>,
): Promise<Static<T> | null> {
  const configuredModel = args.model ?? deps.config.inferenceModel;
  const modelInfo = parseProviderModelConfig({
    name:
      args.model === undefined ? "BB_INFERENCE" : "inference model override",
    value: configuredModel,
  });
  if (
    !isServerDirectAiServiceId(modelInfo.provider) &&
    deps.aiServices.get(modelInfo.provider) !== null
  ) {
    return completeWithAiService(deps, modelInfo, args);
  }

  const model = getInferenceModel(deps, modelInfo);
  if (!model) {
    return null;
  }

  const tools: Tool<T>[] = [
    {
      name: RESULT_TOOL_NAME,
      description: "Return the result as structured JSON.",
      parameters: args.schema,
    },
  ];

  const timeoutMs = args.timeoutMs;
  const abortController = timeoutMs ? new AbortController() : null;
  const completionPromise = getInferenceModels().complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: args.prompt,
          timestamp: Date.now(),
        },
      ],
      tools,
    },
    abortController ? { signal: abortController.signal } : undefined,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  const response = timeoutMs
    ? await Promise.race([
        completionPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new InferenceTimeoutError({ timeoutMs }));
            abortController?.abort();
          }, timeoutMs);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      })
    : await completionPromise;

  const toolCall = response.content.find(
    (item) => item.type === "toolCall" && item.name === RESULT_TOOL_NAME,
  );
  if (!toolCall || toolCall.type !== "toolCall") {
    return null;
  }

  return validateToolCall(tools, toolCall) as Static<T>;
}
