import {
  readCodexAuthFile,
  resolveApiKeyFromCodexAuthFile,
  type CodexAuthFile,
} from "./codex-auth.js";

const DEFAULT_API_KEY_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TITLE_MODEL = "gpt-5.1-codex-mini";
const DEFAULT_RESPONSES_INSTRUCTIONS =
  "You are a concise assistant. Follow the user request and return only the requested output.";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_ERROR_LENGTH = 220;

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

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function truncateErrorText(raw: string): string {
  return raw.length > MAX_UPSTREAM_ERROR_LENGTH
    ? `${raw.slice(0, MAX_UPSTREAM_ERROR_LENGTH - 1)}...`
    : raw;
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = normalizeErrorText(value);
    return normalized.length > 0 ? truncateErrorText(normalized) : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const message = extractErrorMessage(entry);
      if (message) return message;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;

  const candidates = [record.message, record.error, record.detail];
  for (const candidate of candidates) {
    const message = extractErrorMessage(candidate);
    if (message) return message;
  }

  return null;
}

function parseUpstreamErrorMessage(rawBody: string): string | null {
  const normalized = normalizeErrorText(rawBody);
  if (!normalized) return null;

  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized) as OpenAIResponsesErrorPayload;
      return (
        extractErrorMessage(parsed.error?.message) ??
        extractErrorMessage(parsed.message) ??
        extractErrorMessage(parsed)
      );
    } catch {
      return truncateErrorText(normalized);
    }
  }

  return truncateErrorText(normalized);
}

function parseResponseIdFromRecord(value: Record<string, unknown>): string | undefined {
  return typeof value.id === "string" ? value.id : undefined;
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

    const eventRecord = asRecord(parsed);
    if (!eventRecord) continue;

    const type = asNonEmptyString(eventRecord.type);
    if (!type) continue;

    if (type === "response.output_text.delta") {
      const delta = asNonEmptyString(eventRecord.delta);
      if (delta) textDeltas.push(delta);
      continue;
    }

    if (type === "response.output_text.done") {
      const doneText = asNonEmptyString(eventRecord.text);
      if (doneText) textDone.push(doneText);
      continue;
    }

    if (type === "response.completed") {
      const responseRecord = asRecord(eventRecord.response);
      if (!responseRecord) continue;

      responseId = parseResponseIdFromRecord(responseRecord) ?? responseId;
      const completedText = collectOutputText(responseRecord).trim();
      if (completedText) {
        textFromCompleted = completedText;
      }
      continue;
    }

    if (type === "response.created" || type === "response.in_progress") {
      const responseRecord = asRecord(eventRecord.response);
      if (!responseRecord) continue;
      responseId = parseResponseIdFromRecord(responseRecord) ?? responseId;
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

function collectOutputText(payload: Record<string, unknown>): string {
  const direct = payload.output_text;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) {
    const fragments = direct
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter((entry) => entry.length > 0);
    if (fragments.length > 0) return fragments.join("");
  }

  const output = payload.output;
  if (!Array.isArray(output)) return "";

  const fragments: string[] = [];
  for (const item of output) {
    const outputItem = asRecord(item);
    if (!outputItem) continue;
    const content = outputItem.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      const contentPart = asRecord(part);
      if (!contentPart) continue;
      if (typeof contentPart.text === "string" && contentPart.text.length > 0) {
        fragments.push(contentPart.text);
        continue;
      }
      if (
        typeof contentPart.output_text === "string" &&
        contentPart.output_text.length > 0
      ) {
        fragments.push(contentPart.output_text);
      }
    }
  }

  return fragments.join("");
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
  headers.set("User-Agent", "beanbag-agent-server/openai-responses");
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
    const responseId = parseResponseIdFromRecord(payloadRecord);

    const text = collectOutputText(payloadRecord).trim();
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
