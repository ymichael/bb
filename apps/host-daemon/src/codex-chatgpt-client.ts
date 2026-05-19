import { jsonValueSchema, type JsonObject, type JsonValue } from "@bb/domain";
import type {
  HostDaemonCommand,
  HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import { ExpectedCommandDispatchError } from "./command-dispatch-support.js";
import {
  getChatGptCloudflareCookieHeader,
  storeChatGptCloudflareCookies,
} from "./chatgpt-cloudflare-cookies.js";
import {
  readCodexAuthCredentials,
  type CodexAuthCredentials,
  type CodexChatGptAuthCredentials,
  type CodexOpenAiApiKeyCredentials,
} from "./codex-auth.js";

type InferenceCompleteCommand = Extract<
  HostDaemonCommand,
  { type: "codex.inference.complete" }
>;
type VoiceTranscribeCommand = Extract<
  HostDaemonCommand,
  { type: "codex.voice.transcribe" }
>;

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const CODEX_ERROR_TEXT_MAX_BYTES = 4 * 1024;
const CODEX_SSE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const CODEX_SSE_EVENT_MAX_CHARS = 1024 * 1024;
const CODEX_TRANSCRIPTION_RESPONSE_MAX_BYTES = 1024 * 1024;

type ReadOverflowBehavior = "throw" | "truncate";

interface TimeoutFetchArgs {
  timeoutMs: number;
  work: (signal: AbortSignal) => Promise<Response>;
}

interface ReadChunkWithTimeoutArgs {
  readTimeoutMs: number;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}

interface ReadLimitedResponseTextArgs {
  maxBytes: number;
  overflowBehavior: ReadOverflowBehavior;
  readTimeoutMs: number;
}

interface ReadResponseTextFromSseArgs {
  maxBytes: number;
  maxEventChars: number;
  readTimeoutMs: number;
}

interface ChatGptFetchArgs {
  url: string;
  init: (headers: Headers) => RequestInit;
}

interface ResponsesFetchArgs {
  auth: CodexAuthCredentials;
  command: InferenceCompleteCommand;
  request: CodexResponsesRequest;
}

interface ChatGptResponsesFetchArgs {
  auth: CodexChatGptAuthCredentials;
  command: InferenceCompleteCommand;
  request: CodexResponsesRequest;
}

interface OpenAiResponsesFetchArgs {
  auth: CodexOpenAiApiKeyCredentials;
  command: InferenceCompleteCommand;
  request: CodexResponsesRequest;
}

interface TranscriptionFetchArgs {
  auth: CodexAuthCredentials;
  command: VoiceTranscribeCommand;
}

interface ChatGptTranscriptionFetchArgs {
  auth: CodexChatGptAuthCredentials;
  command: VoiceTranscribeCommand;
}

interface OpenAiTranscriptionFetchArgs {
  auth: CodexOpenAiApiKeyCredentials;
  command: VoiceTranscribeCommand;
}

interface CodexResponseFormat {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: JsonValue;
}

interface CodexResponsesRequest {
  model: string;
  instructions: string;
  store: boolean;
  stream: boolean;
  input: CodexInputMessage[];
  text: {
    format: CodexResponseFormat;
  };
}

interface CodexInputMessage {
  role: "user";
  content: CodexInputContent[];
}

interface CodexInputContent {
  type: "input_text";
  text: string;
}

interface ResponseTextResult {
  text: string;
  failedMessage: string | null;
}

function jsonObject(value: JsonValue): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function optionalJsonArray(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function parseJsonValue(raw: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(raw));
}

function isCloudflareChallenge(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
  );
}

function createChatGptHeaders(auth: CodexChatGptAuthCredentials): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("chatgpt-account-id", auth.accountId);
  headers.set("originator", "bb");
  headers.set("User-Agent", "bb-host-daemon");
  if (auth.isFedrampAccount) {
    headers.set("X-OpenAI-Fedramp", "true");
  }
  return headers;
}

function createOpenAiHeaders(auth: CodexOpenAiApiKeyCredentials): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.apiKey}`);
  headers.set("User-Agent", "bb-host-daemon");
  return headers;
}

function createOpenAiResponsesHeaders(
  auth: CodexOpenAiApiKeyCredentials,
): Headers {
  const headers = createOpenAiHeaders(auth);
  headers.set("Accept", "text/event-stream");
  headers.set("Content-Type", "application/json");
  return headers;
}

async function runWithTimeout(args: TimeoutFetchArgs): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, args.timeoutMs);
  timeout.unref();
  try {
    return await args.work(abortController.signal);
  } catch (error) {
    if (abortController.signal.aborted) {
      throw codexRequestTimeoutError(args.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function codexRequestTimeoutError(
  timeoutMs: number,
): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(
    "codex_request_timeout",
    `Codex request timed out after ${timeoutMs}ms`,
  );
}

function codexResponseTooLargeError(): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(
    "codex_response_too_large",
    "Codex response exceeded the maximum supported size.",
  );
}

async function readChunkWithTimeout({
  reader,
  readTimeoutMs,
}: ReadChunkWithTimeoutArgs): Promise<
  ReadableStreamReadResult<Uint8Array>
> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(codexRequestTimeoutError(readTimeoutMs));
        }, readTimeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The caller is already handling the primary read failure.
  }
}

async function readLimitedResponseText(
  response: Response,
  args: ReadLimitedResponseTextArgs,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const chunk = await readChunkWithTimeout({
        reader,
        readTimeoutMs: args.readTimeoutMs,
      });
      if (chunk.done) {
        break;
      }

      const value = chunk.value;
      totalBytes += value.byteLength;
      if (totalBytes > args.maxBytes) {
        if (args.overflowBehavior === "throw") {
          await cancelReaderBestEffort(reader);
          throw codexResponseTooLargeError();
        }
        const allowedBytes = value.byteLength - (totalBytes - args.maxBytes);
        if (allowedBytes > 0) {
          chunks.push(decoder.decode(value.slice(0, allowedBytes), {
            stream: true,
          }));
        }
        truncated = true;
        await cancelReaderBestEffort(reader);
        break;
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return `${chunks.join("")}${truncated ? "..." : ""}`;
  } catch (error) {
    await cancelReaderBestEffort(reader);
    throw error;
  }
}

async function fetchChatGpt(args: ChatGptFetchArgs): Promise<Response> {
  const fetchOnce = async (): Promise<Response> => {
    const headers = new Headers();
    const cookie = getChatGptCloudflareCookieHeader(args.url);
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    const init = args.init(headers);
    const response = await fetch(args.url, init);
    storeChatGptCloudflareCookies(args.url, response.headers);
    return response;
  };

  const response = await fetchOnce();
  if (!isCloudflareChallenge(response)) {
    return response;
  }
  return fetchOnce();
}

async function readErrorText(
  response: Response,
  readTimeoutMs: number,
): Promise<string> {
  const text = await readLimitedResponseText(response, {
    maxBytes: CODEX_ERROR_TEXT_MAX_BYTES,
    overflowBehavior: "truncate",
    readTimeoutMs,
  }).catch(() => "");
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function getCodexResponseText(response: JsonObject): string | null {
  const output = optionalJsonArray(response.output);
  if (!output) {
    return null;
  }
  for (const outputItem of output) {
    const item = jsonObject(outputItem);
    const content = item ? optionalJsonArray(item.content) : null;
    if (!content) {
      continue;
    }
    for (const contentItem of content) {
      const contentObject = jsonObject(contentItem);
      if (!contentObject) {
        continue;
      }
      const type = optionalString(contentObject.type);
      const text =
        optionalString(contentObject.text) ??
        optionalString(contentObject.output_text);
      if ((type === "output_text" || type === "text") && text !== null) {
        return text;
      }
    }
  }
  return null;
}

function getCodexFailureMessage(response: JsonObject): string | null {
  const error = response.error ? jsonObject(response.error) : null;
  if (!error) {
    return null;
  }
  return optionalString(error.message) ?? optionalString(error.code);
}

function extractTextFromSseEvent(event: JsonObject): ResponseTextResult {
  const type = optionalString(event.type);
  if (type === "error") {
    return {
      text: "",
      failedMessage:
        optionalString(event.message) ??
        optionalString(event.code) ??
        "Codex response failed",
    };
  }

  if (type === "response.failed") {
    const response = event.response ? jsonObject(event.response) : null;
    return {
      text: "",
      failedMessage: response
        ? (getCodexFailureMessage(response) ?? "Codex response failed")
        : "Codex response failed",
    };
  }

  if (type === "response.output_text.delta") {
    return {
      text: optionalString(event.delta) ?? "",
      failedMessage: null,
    };
  }

  if (type === "response.completed" || type === "response.done") {
    const response = event.response ? jsonObject(event.response) : null;
    const text = response ? getCodexResponseText(response) : null;
    const failedMessage = response ? getCodexFailureMessage(response) : null;
    return {
      text: text ?? "",
      failedMessage,
    };
  }

  return {
    text: "",
    failedMessage: null,
  };
}

function parseSseEventValue(eventData: string): JsonValue {
  try {
    return parseJsonValue(eventData);
  } catch {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex SSE event was not valid JSON.",
    );
  }
}

async function readResponseTextFromSse(
  response: Response,
  args: ReadResponseTextFromSseArgs,
): Promise<string> {
  if (!response.body) {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex response did not include a response body.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let finalText: string | null = null;
  let failedMessage: string | null = null;
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await readChunkWithTimeout({
        reader,
        readTimeoutMs: args.readTimeoutMs,
      });
      if (chunk.done) {
        break;
      }

      totalBytes += chunk.value.byteLength;
      if (totalBytes > args.maxBytes) {
        throw codexResponseTooLargeError();
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > args.maxEventChars) {
        throw codexResponseTooLargeError();
      }

      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const block = buffer.slice(0, index);
        if (block.length > args.maxEventChars) {
          throw codexResponseTooLargeError();
        }
        buffer = buffer.slice(index + 2);
        const eventData = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (eventData && eventData !== "[DONE]") {
          const eventValue = parseSseEventValue(eventData);
          const event = jsonObject(eventValue);
          if (event) {
            const result = extractTextFromSseEvent(event);
            if (result.failedMessage) {
              failedMessage = result.failedMessage;
            }
            if (result.text) {
              if (
                optionalString(event.type) === "response.completed" ||
                optionalString(event.type) === "response.done"
              ) {
                finalText = result.text;
              } else {
                deltaText += result.text;
              }
            }
          }
        }
        index = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    await cancelReaderBestEffort(reader);
    throw error;
  }

  if (failedMessage) {
    throw new ExpectedCommandDispatchError(
      "codex_request_failed",
      failedMessage,
    );
  }

  const text = finalText ?? deltaText;
  if (!text) {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex response did not include structured output text.",
    );
  }
  return text;
}

function parseStructuredResult(rawText: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = parseJsonValue(rawText);
  } catch {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex structured output was not valid JSON.",
    );
  }
  const object = jsonObject(parsed);
  if (!object) {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex structured output was not a JSON object.",
    );
  }
  return object;
}

function withStrictObjectSchemas(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => withStrictObjectSchemas(item));
  }

  const object = jsonObject(value);
  if (!object) {
    return value;
  }

  const normalized: JsonObject = {};
  for (const [key, childValue] of Object.entries(object)) {
    normalized[key] = withStrictObjectSchemas(childValue);
  }
  if (
    normalized.type === "object" &&
    normalized.additionalProperties === undefined
  ) {
    normalized.additionalProperties = false;
  }
  if (normalized.type === "object") {
    normalized.required = Object.keys(jsonObject(normalized.properties) ?? {});
  }
  return normalized;
}

function buildCodexResponsesRequest(
  command: InferenceCompleteCommand,
): CodexResponsesRequest {
  return {
    model: command.model,
    instructions:
      "Follow the user prompt and respond with structured JSON that matches the requested schema.",
    store: false,
    stream: true,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: command.prompt,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "result",
        strict: true,
        schema: withStrictObjectSchemas(command.outputSchema),
      },
    },
  };
}

function createChatGptResponsesHeaders(
  auth: CodexChatGptAuthCredentials,
  cloudflareHeaders: Headers,
): Headers {
  const headers = createChatGptHeaders(auth);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("Accept", "text/event-stream");
  headers.set("Content-Type", "application/json");
  for (const [key, value] of cloudflareHeaders) {
    headers.set(key, value);
  }
  return headers;
}

function createChatGptTranscriptionHeaders(
  auth: CodexChatGptAuthCredentials,
  cloudflareHeaders: Headers,
): Headers {
  const headers = createChatGptHeaders(auth);
  for (const [key, value] of cloudflareHeaders) {
    headers.set(key, value);
  }
  return headers;
}

async function fetchChatGptResponses(
  args: ChatGptResponsesFetchArgs,
): Promise<Response> {
  return runWithTimeout({
    timeoutMs: args.command.timeoutMs,
    work: (signal) =>
      fetchChatGpt({
        url: CODEX_RESPONSES_URL,
        init: (headers) => ({
          method: "POST",
          headers: createChatGptResponsesHeaders(args.auth, headers),
          body: JSON.stringify(args.request),
          signal,
        }),
      }),
  });
}

async function fetchOpenAiResponses(
  args: OpenAiResponsesFetchArgs,
): Promise<Response> {
  return runWithTimeout({
    timeoutMs: args.command.timeoutMs,
    work: (signal) =>
      fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: createOpenAiResponsesHeaders(args.auth),
        body: JSON.stringify(args.request),
        signal,
      }),
  });
}

async function fetchResponses(args: ResponsesFetchArgs): Promise<Response> {
  return args.auth.type === "chatgpt"
    ? fetchChatGptResponses({
        auth: args.auth,
        command: args.command,
        request: args.request,
      })
    : fetchOpenAiResponses({
        auth: args.auth,
        command: args.command,
        request: args.request,
      });
}

export async function completeCodexInference(
  command: InferenceCompleteCommand,
): Promise<HostDaemonCommandResult<"codex.inference.complete">> {
  const auth = await readCodexAuthCredentials();
  const request = buildCodexResponsesRequest(command);
  const response = await fetchResponses({ auth, command, request });

  if (!response.ok) {
    throw new ExpectedCommandDispatchError(
      response.status === 401 ? "codex_auth_failed" : "codex_request_failed",
      `Codex inference request failed with HTTP ${response.status}: ${await readErrorText(response, command.timeoutMs)}`,
    );
  }

  const rawText = await readResponseTextFromSse(response, {
    maxBytes: CODEX_SSE_RESPONSE_MAX_BYTES,
    maxEventChars: CODEX_SSE_EVENT_MAX_CHARS,
    readTimeoutMs: command.timeoutMs,
  });
  return {
    model: command.model,
    value: parseStructuredResult(rawText),
  };
}

function buildAudioBlob(command: VoiceTranscribeCommand): Blob {
  const bytes = Buffer.from(command.audioBase64, "base64");
  return new Blob([bytes], {
    type: command.mimeType,
  });
}

function buildTranscriptionFormData(command: VoiceTranscribeCommand): FormData {
  const formData = new FormData();
  formData.set("file", buildAudioBlob(command), command.filename);
  formData.set("model", command.model);
  if (command.prompt !== null) {
    formData.set("prompt", command.prompt);
  }
  return formData;
}

function parseTranscriptionText(value: JsonValue): string {
  const object = jsonObject(value);
  const text = object ? optionalString(object.text) : null;
  if (text === null) {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex transcription response did not include transcript text.",
    );
  }
  return text;
}

function parseTranscriptionResponse(rawText: string): JsonValue {
  try {
    return parseJsonValue(rawText);
  } catch {
    throw new ExpectedCommandDispatchError(
      "codex_response_invalid",
      "Codex transcription response was not valid JSON.",
    );
  }
}

async function fetchChatGptTranscription(
  args: ChatGptTranscriptionFetchArgs,
): Promise<Response> {
  return runWithTimeout({
    timeoutMs: args.command.timeoutMs,
    work: (signal) =>
      fetchChatGpt({
        url: CHATGPT_TRANSCRIBE_URL,
        init: (headers) => ({
          method: "POST",
          headers: createChatGptTranscriptionHeaders(args.auth, headers),
          body: buildTranscriptionFormData(args.command),
          signal,
        }),
      }),
  });
}

async function fetchOpenAiTranscription(
  args: OpenAiTranscriptionFetchArgs,
): Promise<Response> {
  return runWithTimeout({
    timeoutMs: args.command.timeoutMs,
    work: (signal) =>
      fetch(OPENAI_TRANSCRIBE_URL, {
        method: "POST",
        headers: createOpenAiHeaders(args.auth),
        body: buildTranscriptionFormData(args.command),
        signal,
      }),
  });
}

async function fetchTranscription(
  args: TranscriptionFetchArgs,
): Promise<Response> {
  return args.auth.type === "chatgpt"
    ? fetchChatGptTranscription({
        auth: args.auth,
        command: args.command,
      })
    : fetchOpenAiTranscription({
        auth: args.auth,
        command: args.command,
      });
}

export async function transcribeCodexVoice(
  command: VoiceTranscribeCommand,
): Promise<HostDaemonCommandResult<"codex.voice.transcribe">> {
  const auth = await readCodexAuthCredentials();
  const response = await fetchTranscription({ auth, command });

  if (!response.ok) {
    throw new ExpectedCommandDispatchError(
      response.status === 401 ? "codex_auth_failed" : "codex_request_failed",
      `Codex transcription request failed with HTTP ${response.status}: ${await readErrorText(response, command.timeoutMs)}`,
    );
  }

  const responseText = await readLimitedResponseText(response, {
    maxBytes: CODEX_TRANSCRIPTION_RESPONSE_MAX_BYTES,
    overflowBehavior: "throw",
    readTimeoutMs: command.timeoutMs,
  });

  return {
    model: command.model,
    text: parseTranscriptionText(parseTranscriptionResponse(responseText)),
  };
}
