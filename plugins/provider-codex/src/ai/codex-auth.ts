import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolveCodexHome } from "../codex-home.js";
import { AiServiceFailure } from "./failure.js";

export type JsonObject = { [key: string]: JsonValue };

const CODEX_AUTH_FILE_NAME = "auth.json";
const CHATGPT_AUTH_CLAIM_PATH = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM_PATH = "https://api.openai.com/profile";

export interface CodexChatGptAuthCredentials {
  type: "chatgpt";
  accessToken: string;
  accountId: string;
  accountEmail: string | null;
  expired: boolean;
  isFedrampAccount: boolean;
}

export interface CodexOpenAiApiKeyCredentials {
  type: "apiKey";
  apiKey: string;
}

export type CodexAuthCredentials =
  | CodexChatGptAuthCredentials
  | CodexOpenAiApiKeyCredentials;

export type CodexAuthUnusableReason =
  | "not_object"
  | "api_key"
  | "access_token"
  | "account_id";

export type CodexAuthFile =
  | { state: "missing"; authPath: string }
  | { state: "unreadable"; authPath: string; error: Error }
  | { state: "malformed"; authPath: string; error: Error }
  | { state: "unusable"; authPath: string; reason: CodexAuthUnusableReason }
  | { state: "ok"; authPath: string; credentials: CodexAuthCredentials };

type ClassifiedAuthJson =
  | { state: "unusable"; reason: CodexAuthUnusableReason }
  | { state: "ok"; credentials: CodexAuthCredentials };

function codexAuthPath(): string {
  return path.join(
    resolveCodexHome(os.homedir(), process.env),
    CODEX_AUTH_FILE_NAME,
  );
}

function toJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  return value;
}

function nonEmptyString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export function parseJsonValue(raw: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(raw));
}

function decodeJwtPayload(token: string): JsonObject | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    return toJsonObject(parseJsonValue(decoded));
  } catch {
    return null;
  }
}

function chatGptClaims(token: string): JsonObject | null {
  return toJsonObject(decodeJwtPayload(token)?.[CHATGPT_AUTH_CLAIM_PATH]);
}

function accountEmail(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const profile = toJsonObject(payload?.[CHATGPT_PROFILE_CLAIM_PATH]);
  return nonEmptyString(payload?.email) ?? nonEmptyString(profile?.email);
}

function tokenExpired(token: string): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Date.now() >= exp * 1000;
}

function errnoCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function classifyAuthJson(value: JsonValue): ClassifiedAuthJson {
  const parsed = toJsonObject(value);
  if (parsed === null) {
    return { state: "unusable", reason: "not_object" };
  }
  const authMode = nonEmptyString(parsed.auth_mode);
  const apiKey = nonEmptyString(parsed.OPENAI_API_KEY);
  if (
    authMode === "apikey" ||
    authMode === "apiKey" ||
    (authMode === null && apiKey !== null)
  ) {
    return apiKey === null
      ? { state: "unusable", reason: "api_key" }
      : { state: "ok", credentials: { type: "apiKey", apiKey } };
  }
  const tokens = toJsonObject(parsed.tokens);
  const accessToken = nonEmptyString(tokens?.access_token);
  if (tokens === null || accessToken === null) {
    return { state: "unusable", reason: "access_token" };
  }
  const claims = chatGptClaims(accessToken);
  const idToken = nonEmptyString(tokens.id_token);
  const idTokenClaims =
    idToken === null ? toJsonObject(tokens.id_token) : chatGptClaims(idToken);
  const accountId =
    nonEmptyString(tokens.account_id) ??
    nonEmptyString(claims?.chatgpt_account_id) ??
    nonEmptyString(idTokenClaims?.chatgpt_account_id);
  if (accountId === null) {
    return { state: "unusable", reason: "account_id" };
  }
  return {
    state: "ok",
    credentials: {
      type: "chatgpt",
      accessToken,
      accountId,
      accountEmail:
        accountEmail(accessToken) ??
        (idToken === null ? null : accountEmail(idToken)),
      expired: tokenExpired(accessToken),
      isFedrampAccount:
        claims?.chatgpt_account_is_fedramp === true ||
        idTokenClaims?.chatgpt_account_is_fedramp === true,
    },
  };
}

export async function readCodexAuthFile(): Promise<CodexAuthFile> {
  const authPath = codexAuthPath();
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch (error) {
    return errnoCode(error) === "ENOENT"
      ? { state: "missing", authPath }
      : { state: "unreadable", authPath, error: toError(error) };
  }
  let value: JsonValue;
  try {
    value = parseJsonValue(raw);
  } catch (error) {
    return { state: "malformed", authPath, error: toError(error) };
  }
  return { ...classifyAuthJson(value), authPath };
}

const UNUSABLE_AUTH_MESSAGES: Record<
  CodexAuthUnusableReason,
  (authPath: string) => string
> = {
  not_object: (authPath) =>
    `Codex auth file at ${authPath} is not valid JSON. Run codex login on this host.`,
  api_key: (authPath) =>
    `Codex auth file at ${authPath} does not contain a usable API key. Run codex login on this host.`,
  access_token: (authPath) =>
    `Codex auth file at ${authPath} does not contain a usable access token. Run codex login on this host.`,
  account_id: () =>
    "Codex auth tokens do not include a ChatGPT account id. Run codex login on this host.",
};

export async function readCodexAuthCredentials(): Promise<CodexAuthCredentials> {
  const auth = await readCodexAuthFile();
  switch (auth.state) {
    case "ok":
      return auth.credentials;
    case "missing":
    case "unreadable":
      throw new AiServiceFailure(
        "auth_required",
        "codex_auth_missing",
        `Codex auth file not found at ${auth.authPath}. Run codex login on this host.`,
      );
    case "malformed":
      throw new AiServiceFailure(
        "auth_required",
        "codex_auth_invalid",
        UNUSABLE_AUTH_MESSAGES.not_object(auth.authPath),
      );
    case "unusable":
      throw new AiServiceFailure(
        "auth_required",
        "codex_auth_invalid",
        UNUSABLE_AUTH_MESSAGES[auth.reason](auth.authPath),
      );
  }
}
