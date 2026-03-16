import {
  readCodexAuthFile,
  resolveApiKeyFromCodexAuthFile,
  type CodexAuthFile,
} from "./codex-auth.js";
import { extractErrorMessage } from "@bb/core";
import { renderTemplate } from "@bb/templates";

const DEFAULT_API_KEY_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TITLE_MODEL = "gpt-5.1-codex-mini";
const DEFAULT_RESPONSES_INSTRUCTIONS = renderTemplate(
  "openaiResponsesDefaultInstructions",
  {},
);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_ERROR_LENGTH = 220;
const ERROR_EXTRACT_OPTS = { maxLength: MAX_UPSTREAM_ERROR_LENGTH, legacyKeys: ["error", "detail"] as const };

type ResponsesAuthMode = "apiKey" | "chatgpt";

interface ResolvedResponsesAuth {
  mode: ResponsesAuthMode;
  bearerToken: string;
  accountId?: string;
}

type KnownAuthMode = "apikey" | "apiKey" | "chatgpt" | "chatgptAuthTokens";

interface OpenAIResponsesErrorPayload {
  error?: {
    message?: unknown;
  };
  message?: unknown;
}

interface ParsedSseResponsePayload {
  text: string;
  responseId?: string;
}

interface DecodedOpenAIResponse {
  id?: string;
  text: string;
}

type DecodedSseEvent =
  | {
      type: "response.output_text.delta";
      delta: string;
    }
  | {
      type: "response.output_text.done";
      text: string;
    }
  | {
      type: "response.created" | "response.in_progress" | "response.completed";
      response: DecodedOpenAIResponse;
    };

export interface GenerateOpenAIResponsesTextArgs {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GenerateOpenAIResponsesTextResult {
  text: string;
  model: string;
  responseId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeBaseUrl(authMode: ResponsesAuthMode): string {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  if (!raw) {
    return authMode === "chatgpt" ? DEFAULT_CHATGPT_BASE_URL : DEFAULT_API_KEY_BASE_URL;
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function resolveModel(model?: string): string {
  const fromArgs = model?.trim();
  if (fromArgs) return fromArgs;
  const fromEnv = process.env.BB_INFERENCE_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_TITLE_MODEL;
}

function parseUpstreamErrorMessage(rawBody: string): string | null {
  const normalized = rawBody.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized) as OpenAIResponsesErrorPayload;
      return (
        extractErrorMessage(parsed.error?.message, ERROR_EXTRACT_OPTS) ??
        extractErrorMessage(parsed.message, ERROR_EXTRACT_OPTS) ??
        extractErrorMessage(parsed, ERROR_EXTRACT_OPTS)
      );
    } catch {
      return extractErrorMessage(normalized, ERROR_EXTRACT_OPTS);
    }
  }

  return extractErrorMessage(normalized, ERROR_EXTRACT_OPTS);
}

function decodeOpenAIResponse(value: unknown): DecodedOpenAIResponse | null {
  const payload = asRecord(value);
  if (!payload) return null;

  const direct = payload.output_text;
  if (typeof direct === "string") {
    return {
      id: asNonEmptyString(payload.id) ?? undefined,
      text: direct,
    };
  }

  if (Array.isArray(direct)) {
    const fragments = direct
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter((entry) => entry.length > 0);
    if (fragments.length > 0) {
      return {
        id: asNonEmptyString(payload.id) ?? undefined,
        text: fragments.join(""),
      };
    }
  }

  const fragments: string[] = [];
  for (const item of asArray(payload.output)) {
    const outputItem = asRecord(item);
    if (!outputItem) continue;

    for (const part of asArray(outputItem.content)) {
      const contentPart = asRecord(part);
      if (!contentPart) continue;

      const text =
        asNonEmptyString(contentPart.text) ??
        asNonEmptyString(contentPart.output_text);
      if (text) {
        fragments.push(text);
      }
    }
  }

  return {
    id: asNonEmptyString(payload.id) ?? undefined,
    text: fragments.join(""),
  };
}

function decodeSseEvent(value: unknown): DecodedSseEvent | null {
  const eventRecord = asRecord(value);
  if (!eventRecord) return null;

  const type = asNonEmptyString(eventRecord.type);
  if (!type) return null;

  switch (type) {
    case "response.output_text.delta": {
      const delta = asNonEmptyString(eventRecord.delta);
      return delta ? { type, delta } : null;
    }
    case "response.output_text.done": {
      const text = asNonEmptyString(eventRecord.text);
      return text ? { type, text } : null;
    }
    case "response.created":
    case "response.in_progress":
    case "response.completed": {
      const response = decodeOpenAIResponse(eventRecord.response);
      return response ? { type, response } : null;
    }
    default:
      // OpenAI SSE event types are open_external; unknown events are ignored.
      return null;
  }
}

function parseSseResponsePayload(rawBody: string): ParsedSseResponsePayload | null {
  if (!rawBody.includes("event:") || !rawBody.includes("data:")) {
    return null;
  }

  const blocks = rawBody.split(/\n\n+/);
  const textDeltas: string[] = [];
  const textDone: string[] = [];
  let textFromCompleted: string | null = null;
  let responseId: string | undefined;

  for (const block of blocks) {
    if (!block.trim()) continue;

    const dataLines = block
      .split("\n")
      .map((line) => line.trimStart())
      .filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;

    const dataPayload = dataLines
      .map((line) => line.slice("data:".length).trim())
      .join("\n")
      .trim();
    if (!dataPayload || dataPayload === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataPayload);
    } catch {
      continue;
    }

    const event = decodeSseEvent(parsed);
    if (!event) continue;

    switch (event.type) {
      case "response.output_text.delta":
        textDeltas.push(event.delta);
        break;
      case "response.output_text.done":
        textDone.push(event.text);
        break;
      case "response.completed":
        responseId = event.response.id ?? responseId;
        if (event.response.text.trim()) {
          textFromCompleted = event.response.text.trim();
        }
        break;
      case "response.created":
      case "response.in_progress":
        responseId = event.response.id ?? responseId;
        break;
      default: {
        const exhausted: never = event;
        throw new Error(`Unhandled SSE event: ${String(exhausted)}`);
      }
    }
  }

  const text =
    textFromCompleted ??
    (textDone.length > 0 ? textDone.join("") : textDeltas.length > 0 ? textDeltas.join("") : "");
  if (!text) return null;

  return {
    text,
    responseId,
  };
}

function resolveKnownAuthMode(value: unknown): KnownAuthMode | null {
  if (
    value === "apikey" ||
    value === "apiKey" ||
    value === "chatgpt" ||
    value === "chatgptAuthTokens"
  ) {
    return value;
  }
  return null;
}

function resolveChatgptAuth(authFile: CodexAuthFile | null): ResolvedResponsesAuth | null {
  const token = asNonEmptyString(authFile?.tokens?.access_token);
  if (!token) return null;

  const accountId = asNonEmptyString(authFile?.tokens?.account_id) ?? undefined;
  return {
    mode: "chatgpt",
    bearerToken: token,
    accountId,
  };
}

function resolveResponsesAuthFromAuthFile(
  authFile: CodexAuthFile | null,
): ResolvedResponsesAuth | null {
  const envApiKey = asNonEmptyString(process.env.OPENAI_API_KEY);
  if (envApiKey) {
    return {
      mode: "apiKey",
      bearerToken: envApiKey,
    };
  }

  const authMode = resolveKnownAuthMode(authFile?.auth_mode);
  const apiKeyAuth = resolveApiKeyFromCodexAuthFile(authFile);
  const chatgptAuth = resolveChatgptAuth(authFile);

  if (authMode) {
    switch (authMode) {
      case "apikey":
      case "apiKey":
        return apiKeyAuth
          ? {
              mode: "apiKey",
              bearerToken: apiKeyAuth,
            }
          : null;
      case "chatgpt":
      case "chatgptAuthTokens":
        return chatgptAuth;
      default: {
        const exhausted: never = authMode;
        throw new Error(`Unhandled auth mode: ${String(exhausted)}`);
      }
    }
  }

  // Tolerate older auth.json variants where mode might be absent.
  if (apiKeyAuth) {
    return {
      mode: "apiKey",
      bearerToken: apiKeyAuth,
    };
  }

  return chatgptAuth;
}

async function resolveResponsesAuth(): Promise<ResolvedResponsesAuth | null> {
  const authFile = await readCodexAuthFile();
  return resolveResponsesAuthFromAuthFile(authFile);
}

export async function generateOpenAIResponsesText(
  args: GenerateOpenAIResponsesTextArgs,
): Promise<GenerateOpenAIResponsesTextResult> {
  const prompt = args.prompt.trim();
  if (!prompt) {
    throw new Error("OpenAI responses prompt cannot be empty.");
  }

  const auth = await resolveResponsesAuth();
  if (!auth) {
    throw new Error(
      "OpenAI auth is missing. Set OPENAI_API_KEY or run `codex login`.",
    );
  }

  const timeoutMs = Math.max(1, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const model = resolveModel(args.model);
  const endpoint = `${normalizeBaseUrl(auth.mode)}/responses`;
  const requestBody: Record<string, unknown> = {
    model,
    instructions: DEFAULT_RESPONSES_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    store: false,
  };

  if (auth.mode === "chatgpt") {
    requestBody.stream = true;
  }
  if (auth.mode === "apiKey" && args.maxOutputTokens !== undefined) {
    requestBody.max_output_tokens = args.maxOutputTokens;
  }
  if (auth.mode === "apiKey" && args.temperature !== undefined) {
    requestBody.temperature = args.temperature;
  }

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.bearerToken}`);
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", "bb-agent-server/openai-responses");
  if (auth.mode === "chatgpt" && auth.accountId) {
    headers.set("ChatGPT-Account-ID", auth.accountId);
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    const rawBody = await response.text();

    if (!response.ok) {
      const upstreamMessage =
        parseUpstreamErrorMessage(rawBody) ?? `request failed with status ${response.status}`;
      throw new Error(`OpenAI responses request failed: ${upstreamMessage}`);
    }

    const ssePayload = parseSseResponsePayload(rawBody);
    if (ssePayload) {
      return {
        text: ssePayload.text,
        model,
        responseId: ssePayload.responseId,
      };
    }

    const payload = rawBody ? (JSON.parse(rawBody) as unknown) : null;
    const payloadRecord = asRecord(payload);
    if (!payloadRecord) {
      throw new Error("OpenAI responses returned an invalid payload.");
    }
    const decodedResponse = decodeOpenAIResponse(payloadRecord);
    const responseId = decodedResponse?.id;
    const text = decodedResponse?.text.trim() ?? "";
    if (!text) {
      throw new Error("OpenAI responses returned no text content.");
    }

    return {
      text,
      model,
      responseId,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"))
    ) {
      throw new Error(`OpenAI responses request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
