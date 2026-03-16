import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { extractErrorMessage } from "@bb/core";
import { invalidRequestError, providerUnavailableError } from "./domain-errors.js";

interface VoiceTranscriptionAuth {
  mode: "chatgpt" | "chatgptAuthTokens" | "apikey";
  bearerToken: string;
}

interface CodexAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: {
    access_token?: unknown;
  };
}

export interface TranscribeVoiceInputArgs {
  file: File;
  prompt?: string;
}

export interface TranscribeVoiceInputResult {
  text: string;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const MAX_UPSTREAM_ERROR_LENGTH = 180;
const ERROR_EXTRACT_OPTS = { maxLength: MAX_UPSTREAM_ERROR_LENGTH, legacyKeys: ["error", "detail"] as const };

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

function parseUpstreamErrorMessage(
  rawBody: string,
  contentType: string | null,
): string | null {
  const normalized = rawBody.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  if (HTML_DOCUMENT_PATTERN.test(normalized)) {
    return null;
  }

  const shouldParseAsJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (shouldParseAsJson) {
    try {
      return extractErrorMessage(JSON.parse(normalized) as unknown, ERROR_EXTRACT_OPTS);
    } catch {
      return null;
    }
  }

  return extractErrorMessage(normalized, ERROR_EXTRACT_OPTS);
}

function createTranscriptionFailureError(
  status: number,
  rawBody: string,
  contentType: string | null,
): Error {
  const upstreamMessage = parseUpstreamErrorMessage(rawBody, contentType);
  switch (status) {
    case 400:
      return invalidRequestError(
        upstreamMessage ?? "Voice transcription request was rejected by the provider.",
      );
    case 401:
    case 403:
      return invalidRequestError(
        "Voice transcription authentication failed. Run `codex login` or set OPENAI_API_KEY, then restart BB server.",
      );
    case 413:
      return invalidRequestError("Voice recording exceeds the provider upload limit.");
    case 415:
      return invalidRequestError(
        "Voice recording format is not supported by the transcription provider.",
      );
    case 429:
      return providerUnavailableError(
        "Voice transcription is rate limited. Please try again shortly.",
      );
    default:
      if (status >= 500) {
        return providerUnavailableError(
          "Voice transcription service is temporarily unavailable. Please try again.",
        );
      }
      if (upstreamMessage) {
        return new Error(`Voice transcription failed (${status}): ${upstreamMessage}`);
      }
      return new Error(`Voice transcription failed (${status}).`);
  }
}

async function readCodexAuthFile(): Promise<CodexAuthFile | null> {
  const authPath = resolve(homedir(), ".codex", "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as CodexAuthFile;
  } catch {
    return null;
  }
}

function resolveApiKeyFromAuthFile(authFile: CodexAuthFile | null): string | null {
  const apiKeyFromEnv = process.env.OPENAI_API_KEY?.trim();
  if (apiKeyFromEnv) return apiKeyFromEnv;

  const maybeApiKey = authFile?.OPENAI_API_KEY;
  if (typeof maybeApiKey === "string" && maybeApiKey.trim().length > 0) {
    return maybeApiKey.trim();
  }
  if (
    maybeApiKey &&
    typeof maybeApiKey === "object" &&
    "value" in maybeApiKey &&
    typeof (maybeApiKey as { value?: unknown }).value === "string"
  ) {
    const value = (maybeApiKey as { value: string }).value.trim();
    if (value.length > 0) return value;
  }
  return null;
}

async function resolveVoiceTranscriptionAuth(): Promise<VoiceTranscriptionAuth> {
  const authFile = await readCodexAuthFile();
  const mode = authFile?.auth_mode;

  if (mode === "chatgpt" || mode === "chatgptAuthTokens") {
    const token = authFile?.tokens?.access_token;
    if (typeof token !== "string" || token.trim().length === 0) {
      throw invalidRequestError(
        "Voice transcription auth is missing. Run `codex login` and restart BB server.",
      );
    }
    return {
      mode,
      bearerToken: token.trim(),
    };
  }

  const apiKey = resolveApiKeyFromAuthFile(authFile);
  if (!apiKey) {
    throw invalidRequestError(
      "Voice transcription is not configured. Set OPENAI_API_KEY or run `codex login`, then restart BB server.",
    );
  }

  return {
    mode: "apikey",
    bearerToken: apiKey,
  };
}

function ensureValidAudioFile(file: File): void {
  if (!(file instanceof File)) {
    throw invalidRequestError("Expected multipart file field named 'file'");
  }
  if (file.size <= 0) {
    throw invalidRequestError("Voice recording cannot be empty");
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw invalidRequestError(
      `Voice recording exceeds ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))}MB limit`,
    );
  }
}

export async function transcribeVoiceInput(
  args: TranscribeVoiceInputArgs,
): Promise<TranscribeVoiceInputResult> {
  ensureValidAudioFile(args.file);
  const auth = await resolveVoiceTranscriptionAuth();

  const formData = new FormData();
  formData.set("file", args.file, args.file.name || "audio.webm");
  formData.set("model", "gpt-4o-transcribe");
  const prompt = args.prompt?.trim();
  if (prompt) {
    formData.set("prompt", prompt);
  }

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.bearerToken}`);
  headers.set("User-Agent", "bb-server/voice-transcription");

  const response = await fetch(OPENAI_TRANSCRIPTION_ENDPOINT, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw createTranscriptionFailureError(
      response.status,
      responseBody,
      response.headers.get("content-type"),
    );
  }

  const json = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof json?.text === "string" ? json.text.trim() : "";
  if (text.length === 0) {
    throw new Error("Voice transcription returned an empty result.");
  }
  return { text };
}
