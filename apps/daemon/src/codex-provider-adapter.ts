import type {
  PromptInput,
  SpawnThreadRequest,
  Thread,
  ThreadEvent,
} from "@beanbag/core";
import { listCodexModels } from "./codex-models.js";
import type {
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderTitleGenerator,
  ProviderTitleGeneratorArgs,
} from "./provider-adapter.js";

const DEFAULT_BASE_INSTRUCTIONS =
  "You are a coding agent working on a project thread. Follow the instructions carefully and write clean, working code.";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeProviderEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 57).trimEnd()}...`;
}

function withExecutionOptions(
  params: Record<string, unknown>,
  options?: ProviderExecutionOptions,
): Record<string, unknown> {
  if (!options) {
    return params;
  }

  const nextParams = { ...params };
  if (options.model) {
    nextParams.model = options.model;
  }
  if (options.reasoningLevel) {
    nextParams.config = {
      model_reasoning_effort: options.reasoningLevel,
    };
  }
  return nextParams;
}

function deriveThreadTitleFromInput(input?: PromptInput[]): string | undefined {
  if (!input || input.length === 0) return undefined;
  const textChunk = input.find(
    (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
      chunk.type === "text" && chunk.text.trim().length > 0,
  );
  if (!textChunk) return undefined;
  return normalizeTitle(textChunk.text);
}

function extractThreadIdFromResult(result: unknown): string | undefined {
  const payload = asRecord(result);
  if (!payload) return undefined;

  if (typeof payload.threadId === "string" && payload.threadId.trim().length > 0) {
    return payload.threadId;
  }

  const thread = asRecord(payload.thread);
  if (thread && typeof thread.id === "string" && thread.id.trim().length > 0) {
    return thread.id;
  }

  return undefined;
}

function outputFromEvent(event: ThreadEvent): string | undefined {
  const normalizedType = normalizeProviderEventType(event.type);
  if (normalizedType !== "item/completed") return undefined;

  const payload = asRecord(event.data);
  const item = asRecord(payload?.item);
  if (!item) return undefined;
  if (item.type !== "agentMessage") return undefined;
  if (typeof item.text !== "string") return undefined;
  return item.text;
}

export interface CreateCodexProviderAdapterOptions {
  titleGenerator?: ProviderTitleGenerator;
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const titleGenerator = opts?.titleGenerator;

  return {
    id: "codex",
    displayName: "Codex app-server",
    capabilities: {
      supportsSteer: true,
      supportsRename: true,
      supportsModelList: true,
      supportsReasoningLevels: true,
      supportsMultimodalInput: true,
    },
    processCommand: "codex",
    processArgs: ["app-server"],
    clientInfo: {
      name: "beanbag",
      version: "0.0.1",
    },
    initializeMethod: "initialize",
    threadStartMethod: "thread/start",
    threadResumeMethod: "thread/resume",
    turnStartMethod: "turn/start",
    turnSteerMethod: "turn/steer",
    threadNameSetMethod: "thread/name/set",
    createThreadStartParams(req: SpawnThreadRequest): Record<string, unknown> {
      return withExecutionOptions(
        {
          approvalPolicy: "never",
          baseInstructions: DEFAULT_BASE_INSTRUCTIONS,
        },
        req,
      );
    },
    createThreadResumeParams(
      providerThreadId: string,
      options?: ProviderExecutionOptions,
    ): Record<string, unknown> {
      return withExecutionOptions({ threadId: providerThreadId }, options);
    },
    createTurnStartParams(
      providerThreadId: string,
      input: PromptInput[],
      options?: ProviderExecutionOptions,
    ): Record<string, unknown> {
      return withExecutionOptions(
        {
          threadId: providerThreadId,
          input,
        },
        options,
      );
    },
    createTurnSteerParams(
      providerThreadId: string,
      expectedTurnId: string,
      input: PromptInput[],
    ): Record<string, unknown> {
      return {
        threadId: providerThreadId,
        expectedTurnId,
        input,
      };
    },
    createThreadNameSetParams(
      providerThreadId: string,
      title: string,
    ): Record<string, unknown> {
      return {
        threadId: providerThreadId,
        name: title,
      };
    },
    extractThreadIdFromResult,
    extractThreadIdFromEventData(data: unknown): string | undefined {
      const payload = asRecord(data);
      if (!payload) return undefined;

      if (typeof payload.threadId === "string" && payload.threadId.trim().length > 0) {
        return payload.threadId;
      }

      const thread = asRecord(payload.thread);
      if (thread && typeof thread.id === "string" && thread.id.trim().length > 0) {
        return thread.id;
      }

      return undefined;
    },
    normalizeEventType(type: string): string {
      return normalizeProviderEventType(type);
    },
    shouldBroadcastForEvent(method: string): boolean {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "item/agentmessage/delta") return false;
      if (normalized === "item/reasoning/summarytextdelta") return false;
      return true;
    },
    statusForEvent(method: string): Thread["status"] | undefined {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "turn/start" || normalized === "turn/started") {
        return "active";
      }
      if (normalized === "turn/completed" || normalized === "turn/end") {
        return "idle";
      }
      return undefined;
    },
    titleFromEvent(method: string, data: unknown): string | undefined {
      const normalizedMethod = normalizeProviderEventType(method);
      const payload = asRecord(data);

      if (normalizedMethod === "thread/started") {
        const thread = asRecord(payload?.thread);
        return normalizeTitle(thread?.preview);
      }

      if (normalizedMethod === "thread/name/updated") {
        return normalizeTitle(payload?.threadName ?? payload?.thread_name);
      }

      return undefined;
    },
    outputFromEvent,
    listModels() {
      return listCodexModels();
    },
    deriveThreadTitle(input?: PromptInput[]): string | undefined {
      return deriveThreadTitleFromInput(input);
    },
    ...(titleGenerator
      ? {
          async generateThreadTitle(
            args: ProviderTitleGeneratorArgs,
          ): Promise<string | undefined> {
            const generated = await titleGenerator(args);
            return normalizeTitle(generated);
          },
        }
      : {}),
    inactiveSessionErrorMessage(threadId: string): string {
      return `Thread ${threadId} has no codex session`;
    },
  };
}
