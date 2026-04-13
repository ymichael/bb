import { complete, getModel, validateToolCall } from "@mariozechner/pi-ai";
import type { Static, TSchema, Tool } from "@mariozechner/pi-ai";
import type { AppDeps } from "../../types.js";

export interface InferenceModelInfo {
  provider: string;
  modelId: string;
}

function parseInferenceModel(model: string): InferenceModelInfo {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(`Invalid inference model: ${model}`);
  }
  return {
    provider: model.slice(0, slashIndex),
    modelId: model.slice(slashIndex + 1),
  };
}

function getInferenceModel(
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

const RESULT_TOOL_NAME = "result";

interface InferenceCompleteArgs<T extends TSchema> {
  prompt: string;
  schema: T;
  timeoutMs?: number;
}

export interface InferenceTimeoutErrorArgs {
  timeoutMs: number;
}

/**
 * Raised when an inference request exceeds its configured timeout budget.
 */
export class InferenceTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(args: InferenceTimeoutErrorArgs) {
    super(`Inference request timed out after ${args.timeoutMs}ms`);
    this.name = "InferenceTimeoutError";
    this.timeoutMs = args.timeoutMs;
  }
}

/**
 * Send a prompt to the configured inference model and return structured
 * output validated via a tool call. The model is given a single tool whose
 * parameters match the provided TypeBox schema; the tool call arguments
 * are validated against the schema and returned. Returns `null` if the
 * model is not configured or does not produce a valid tool call.
 */
export async function inferenceComplete<T extends TSchema>(
  deps: Pick<AppDeps, "config" | "logger">,
  args: InferenceCompleteArgs<T>,
): Promise<Static<T> | null> {
  const model = getInferenceModel(deps);
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
  const completionPromise = complete(
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

  // validateToolCall validates arguments against the TypeBox schema and
  // returns the validated data. Its return type is `any` so the cast is needed.
  return validateToolCall(tools, toolCall) as Static<T>;
}
