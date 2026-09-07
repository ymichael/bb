import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiServiceErrorCode,
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { fetchChatGpt, isCloudflareChallenge } from "./chatgpt-fetch.js";
import {
  parseJsonValue,
  readCodexAuthCredentials,
  type CodexAuthCredentials,
  type CodexChatGptAuthCredentials,
  type CodexOpenAiApiKeyCredentials,
  type JsonObject,
} from "./codex-auth.js";
import { AiServiceFailure } from "./failure.js";

type InferenceCompleteCommand = ExperimentalAiInferenceCompleteInput;
type VoiceTranscribeCommand = ExperimentalAiVoiceTranscribeInput;

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const CODEX_ERROR_TEXT_MAX_BYTES = 4 * 1024;
const CODEX_SSE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const CODEX_SSE_EVENT_MAX_CHARS = 1024 * 1024;
const CODEX_TRANSCRIPTION_RESPONSE_MAX_BYTES = 1024 * 1024;

type ReadOverflowBehavior = "throw" | "truncate";
type CodexRequestOperation = "inference" | "transcription";

interface TimeoutFetchArgs {
  deadline: CodexRequestDeadline;
  work: (signal: AbortSignal) => Promise<Response>;
}

interface CodexRequestDeadline {
  expiresAt: number;
  timeoutMs: number;
}

interface ReadChunkWithTimeoutArgs {
  deadline: CodexRequestDeadline;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}

interface ReadLimitedResponseTextArgs {
  deadline: CodexRequestDeadline;
  maxBytes: number;
  overflowBehavior: ReadOverflowBehavior;
}

interface ReadResponseTextFromSseArgs {
  deadline: CodexRequestDeadline;
  maxBytes: number;
  maxEventChars: number;
}

interface ResponsesFetchArgs {
  auth: CodexAuthCredentials;
  command: InferenceCompleteCommand;
  deadline: CodexRequestDeadline;
  request: CodexResponsesRequest;
}

interface ChatGptResponsesFetchArgs {
  auth: CodexChatGptAuthCredentials;
  command: InferenceCompleteCommand;
  deadline: CodexRequestDeadline;
  request: CodexResponsesRequest;
}

interface OpenAiResponsesFetchArgs {
  auth: CodexOpenAiApiKeyCredentials;
  command: InferenceCompleteCommand;
  deadline: CodexRequestDeadline;
  request: CodexResponsesRequest;
}

interface TranscriptionFetchArgs {
  auth: CodexAuthCredentials;
  command: VoiceTranscribeCommand;
  deadline: CodexRequestDeadline;
}

interface ChatGptTranscriptionFetchArgs {
  auth: CodexChatGptAuthCredentials;
  command: VoiceTranscribeCommand;
  deadline: CodexRequestDeadline;
}

interface OpenAiTranscriptionFetchArgs {
  auth: CodexOpenAiApiKeyCredentials;
  command: VoiceTranscribeCommand;
  deadline: CodexRequestDeadline;
}

interface CodexHttpErrorArgs {
  deadline: CodexRequestDeadline;
  operation: CodexRequestOperation;
  response: Response;
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
  reasoning: {
    effort: InferenceCompleteCommand["reasoningEffort"];
  };
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
  failure: CodexStreamFailure | null;
  text: string;
}

interface CodexStreamFailure {
  code: string | null;
  message: string;
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

function createCodexRequestDeadline(timeoutMs: number): CodexRequestDeadline {
  return {
    expiresAt: performance.now() + timeoutMs,
    timeoutMs,
  };
}

function remainingCodexRequestTimeoutMs(
  deadline: CodexRequestDeadline,
): number {
  const remainingMs = Math.ceil(deadline.expiresAt - performance.now());
  if (remainingMs <= 0) {
    throw codexRequestTimeoutError(deadline.timeoutMs);
  }
  return remainingMs;
}

async function runWithTimeout(args: TimeoutFetchArgs): Promise<Response> {
  const abortController = new AbortController();
  const timeoutMs = remainingCodexRequestTimeoutMs(args.deadline);
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref();
  try {
    return await args.work(abortController.signal);
  } catch (error) {
    if (abortController.signal.aborted) {
      throw codexRequestTimeoutError(args.deadline.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function codexRequestTimeoutError(timeoutMs: number): AiServiceFailure {
  return new AiServiceFailure(
    "timeout",
    "codex_request_timeout",
    `Codex request timed out after ${timeoutMs}ms`,
  );
}

function codexResponseTooLargeError(): AiServiceFailure {
  return new AiServiceFailure(
    "invalid_response",
    "codex_response_too_large",
    "Codex response exceeded the maximum supported size.",
  );
}

async function readChunkWithTimeout({
  deadline,
  reader,
}: ReadChunkWithTimeoutArgs): ReturnType<
  ReadableStreamDefaultReader<Uint8Array>["read"]
> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = remainingCodexRequestTimeoutMs(deadline);
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(codexRequestTimeoutError(deadline.timeoutMs));
        }, timeoutMs);
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
  } catch {}
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
        deadline: args.deadline,
        reader,
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
          chunks.push(
            decoder.decode(value.slice(0, allowedBytes), {
              stream: true,
            }),
          );
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

async function readErrorText(
  response: Response,
  deadline: CodexRequestDeadline,
): Promise<string> {
  const text = await readLimitedResponseText(response, {
    deadline,
    maxBytes: CODEX_ERROR_TEXT_MAX_BYTES,
    overflowBehavior: "truncate",
  }).catch(() => "");
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

type FailureCodes = [generic: ExperimentalAiServiceErrorCode, detail: string];

function codexRequestErrorCode(status: number): FailureCodes {
  if (status === 401) {
    return ["auth_required", "codex_auth_failed"];
  }
  if (status === 429) {
    return ["rate_limited", "codex_rate_limited"];
  }
  if (status >= 500) {
    return ["service_unavailable", "codex_service_unavailable"];
  }
  return ["request_failed", "codex_request_failed"];
}

const CODEX_SERVICE_UNAVAILABLE_PATTERN =
  /\b(?:overloaded|temporarily unavailable|try again later)\b/iu;

function codexStreamFailureErrorCode(
  failure: CodexStreamFailure,
): FailureCodes {
  if (failure.code === "server_error") {
    return ["service_unavailable", "codex_service_unavailable"];
  }
  if (failure.code === "rate_limit_exceeded") {
    return ["rate_limited", "codex_rate_limited"];
  }
  return CODEX_SERVICE_UNAVAILABLE_PATTERN.test(failure.message)
    ? ["service_unavailable", "codex_service_unavailable"]
    : ["request_failed", "codex_request_failed"];
}

function extractJsonErrorMessage(value: JsonValue): string | null {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractJsonErrorMessage(item);
      if (message) {
        return message;
      }
    }
    return null;
  }

  const object = jsonObject(value);
  if (!object) {
    return null;
  }

  for (const key of ["message", "detail", "error"]) {
    const child = object[key];
    if (child === undefined) {
      continue;
    }
    const message = extractJsonErrorMessage(child);
    if (message) {
      return message;
    }
  }
  return null;
}

function extractProviderErrorMessage(rawText: string): string | null {
  const normalized = rawText.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  try {
    return extractJsonErrorMessage(parseJsonValue(normalized)) ?? normalized;
  } catch {
    return normalized;
  }
}

function isHtmlResponse(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/html") ?? false
  );
}

const CODEX_API_KEY_ROUTE_HINT: Record<CodexRequestOperation, string> = {
  inference: "BB_INFERENCE",
  transcription: "BB_TRANSCRIPTION",
};

async function createCodexHttpError({
  deadline,
  operation,
  response,
}: CodexHttpErrorArgs): Promise<AiServiceFailure> {
  const prefix = `Codex ${operation} request failed with HTTP ${response.status}`;
  if (isCloudflareChallenge(response)) {
    return new AiServiceFailure(
      "service_unavailable",
      "codex_service_unavailable",
      `${prefix}: chatgpt.com answered with a Cloudflare challenge that bb cannot solve. Retry, or set ${CODEX_API_KEY_ROUTE_HINT[operation]} to an openai/ model with OPENAI_API_KEY.`,
    );
  }
  const providerMessage = isHtmlResponse(response)
    ? null
    : extractProviderErrorMessage(await readErrorText(response, deadline));
  const details = providerMessage ? `: ${providerMessage}` : "";
  return new AiServiceFailure(
    ...codexRequestErrorCode(response.status),
    `${prefix}${details}`,
  );
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

function getCodexFailure(response: JsonObject): CodexStreamFailure | null {
  const error = response.error ? jsonObject(response.error) : null;
  if (!error) {
    return null;
  }
  const code = optionalString(error.code);
  return {
    code,
    message: optionalString(error.message) ?? code ?? "Codex response failed",
  };
}

function extractTextFromSseEvent(event: JsonObject): ResponseTextResult {
  const type = optionalString(event.type);
  if (type === "error") {
    const code = optionalString(event.code);
    return {
      failure: {
        code,
        message:
          optionalString(event.message) ?? code ?? "Codex response failed",
      },
      text: "",
    };
  }

  if (type === "response.failed") {
    const response = event.response ? jsonObject(event.response) : null;
    return {
      failure: response
        ? (getCodexFailure(response) ?? {
            code: null,
            message: "Codex response failed",
          })
        : { code: null, message: "Codex response failed" },
      text: "",
    };
  }

  if (type === "response.output_text.delta") {
    return {
      failure: null,
      text: optionalString(event.delta) ?? "",
    };
  }

  if (type === "response.completed" || type === "response.done") {
    const response = event.response ? jsonObject(event.response) : null;
    const text = response ? getCodexResponseText(response) : null;
    const failure = response ? getCodexFailure(response) : null;
    return {
      failure,
      text: text ?? "",
    };
  }

  return {
    failure: null,
    text: "",
  };
}

function parseSseEventValue(eventData: string): JsonValue {
  try {
    return parseJsonValue(eventData);
  } catch {
    throw new AiServiceFailure(
      "invalid_response",
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
    throw new AiServiceFailure(
      "invalid_response",
      "codex_response_invalid",
      "Codex response did not include a response body.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let finalText: string | null = null;
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await readChunkWithTimeout({
        deadline: args.deadline,
        reader,
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
            if (result.failure) {
              throw new AiServiceFailure(
                ...codexStreamFailureErrorCode(result.failure),
                result.failure.message,
              );
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

  const text = finalText ?? deltaText;
  if (!text) {
    throw new AiServiceFailure(
      "invalid_response",
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
    throw new AiServiceFailure(
      "invalid_response",
      "codex_response_invalid",
      "Codex structured output was not valid JSON.",
    );
  }
  const object = jsonObject(parsed);
  if (!object) {
    throw new AiServiceFailure(
      "invalid_response",
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
    reasoning: { effort: command.reasoningEffort },
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
    deadline: args.deadline,
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
    deadline: args.deadline,
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
        deadline: args.deadline,
        request: args.request,
      })
    : fetchOpenAiResponses({
        auth: args.auth,
        command: args.command,
        deadline: args.deadline,
        request: args.request,
      });
}

export async function completeCodexInference(
  command: InferenceCompleteCommand,
): Promise<Extract<ExperimentalAiInferenceCompleteOutput, { ok: true }>> {
  const deadline = createCodexRequestDeadline(command.timeoutMs);
  const auth = await readCodexAuthCredentials();
  const request = buildCodexResponsesRequest(command);
  const response = await fetchResponses({ auth, command, deadline, request });

  if (!response.ok) {
    throw await createCodexHttpError({
      deadline,
      operation: "inference",
      response,
    });
  }

  const rawText = await readResponseTextFromSse(response, {
    deadline,
    maxBytes: CODEX_SSE_RESPONSE_MAX_BYTES,
    maxEventChars: CODEX_SSE_EVENT_MAX_CHARS,
  });
  return {
    ok: true,
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
    throw new AiServiceFailure(
      "invalid_response",
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
    throw new AiServiceFailure(
      "invalid_response",
      "codex_response_invalid",
      "Codex transcription response was not valid JSON.",
    );
  }
}

async function fetchChatGptTranscription(
  args: ChatGptTranscriptionFetchArgs,
): Promise<Response> {
  return runWithTimeout({
    deadline: args.deadline,
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
    deadline: args.deadline,
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
        deadline: args.deadline,
      })
    : fetchOpenAiTranscription({
        auth: args.auth,
        command: args.command,
        deadline: args.deadline,
      });
}

export async function transcribeCodexVoice(
  command: VoiceTranscribeCommand,
): Promise<Extract<ExperimentalAiVoiceTranscribeOutput, { ok: true }>> {
  const deadline = createCodexRequestDeadline(command.timeoutMs);
  const auth = await readCodexAuthCredentials();
  const response = await fetchTranscription({ auth, command, deadline });

  if (!response.ok) {
    throw await createCodexHttpError({
      deadline,
      operation: "transcription",
      response,
    });
  }

  const responseText = await readLimitedResponseText(response, {
    deadline,
    maxBytes: CODEX_TRANSCRIPTION_RESPONSE_MAX_BYTES,
    overflowBehavior: "throw",
  });

  return {
    ok: true,
    model: command.model,
    text: parseTranscriptionText(parseTranscriptionResponse(responseText)),
  };
}
