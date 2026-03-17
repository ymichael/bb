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
const ERROR_EXTRACT_OPTS = {
  maxLength: MAX_UPSTREAM_ERROR_LENGTH,
  legacyKeys: ["error", "detail"] as const,
};

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

    const payloadRaw = dataLines
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!payloadRaw || payloadRaw === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadRaw);
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
      case "response.created":
      case "response.in_progress":
      case "response.completed":
        responseId = event.response.id ?? responseId;
        if (event.response.text) {
          textFromCompleted = event.response.text;
        }
        break;
      default:
        event satisfies never;
    }
  }

  const text =
    textDone.join("") ||
    textDeltas.join("") ||
    textFromCompleted ||
    "";

  if (!text) return null;
  return { text, ...(responseId ? { responseId } : {}) };
}

async function resolveResponsesAuth(): Promise<ResolvedResponsesAuth> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return {
      mode: "apiKey",
      bearerToken: apiKey,
    };
  }

  const auth = await readCodexAuthFile();
  const authMode = String(auth?.auth_mode ?? "").trim() as KnownAuthMode;
  if (!authMode) {
    throw new Error("OpenAI auth is missing");
  }
  if (authMode === "apikey" || authMode === "apiKey") {
    const resolvedApiKey = resolveApiKeyFromCodexAuthFile(auth);
    if (!resolvedApiKey) {
      throw new Error("OpenAI API key is missing");
    }
    return {
      mode: "apiKey",
      bearerToken: resolvedApiKey,
    };
  }

  const chatgptAuth = auth as CodexAuthFile & {
    tokens?: {
      id_token?: string;
      access_token?: string;
      account_id?: string;
    };
  };
  const bearerToken =
    chatgptAuth.tokens?.id_token?.trim() ||
    chatgptAuth.tokens?.access_token?.trim();
  if (!bearerToken) {
    throw new Error("OpenAI auth is missing");
  }
  return {
    mode: "chatgpt",
    bearerToken,
    ...(chatgptAuth.tokens?.account_id?.trim()
      ? { accountId: chatgptAuth.tokens.account_id.trim() }
      : {}),
  };
}

export async function generateOpenAIResponsesText(
  args: GenerateOpenAIResponsesTextArgs,
): Promise<GenerateOpenAIResponsesTextResult> {
  const auth = await resolveResponsesAuth();
  const model = resolveModel(args.model);
  const baseUrl = normalizeBaseUrl(auth.mode);
  const timeoutMs = Math.max(1, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${auth.bearerToken}`,
        "content-type": "application/json",
        ...(auth.accountId ? { "openai-account-id": auth.accountId } : {}),
      },
      body: JSON.stringify({
        model,
        input: args.prompt,
        instructions: DEFAULT_RESPONSES_INSTRUCTIONS,
        stream: true,
        ...(args.maxOutputTokens ? { max_output_tokens: args.maxOutputTokens } : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      }),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(parseUpstreamErrorMessage(rawBody) ?? `OpenAI error ${response.status}`);
    }

    const parsedSse = parseSseResponsePayload(rawBody);
    if (parsedSse) {
      return {
        text: parsedSse.text,
        model,
        ...(parsedSse.responseId ? { responseId: parsedSse.responseId } : {}),
      };
    }

    const decoded = decodeOpenAIResponse(JSON.parse(rawBody));
    if (!decoded?.text) {
      throw new Error("OpenAI response did not include output text");
    }

    return {
      text: decoded.text,
      model,
      ...(decoded.id ? { responseId: decoded.id } : {}),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
