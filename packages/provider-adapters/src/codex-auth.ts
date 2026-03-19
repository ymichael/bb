import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ProviderLaunchConfiguration } from "@bb/core";

export interface CodexAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  openai_api_key?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function readCodexAuthFile(): Promise<CodexAuthFile | null> {
  const authPath = resolve(homedir(), ".codex", "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return asRecord(parsed) as CodexAuthFile | null;
  } catch {
    return null;
  }
}

export function resolveApiKeyFromCodexAuthFile(authFile: CodexAuthFile | null): string | null {
  const maybeApiKey = authFile?.OPENAI_API_KEY;
  const directApiKey = asNonEmptyString(maybeApiKey);
  if (directApiKey) {
    return directApiKey;
  }

  const maybeApiKeyRecord = asRecord(maybeApiKey);
  if (maybeApiKeyRecord) {
    const wrappedValue = asNonEmptyString(maybeApiKeyRecord.value);
    if (wrappedValue) {
      return wrappedValue;
    }
  }

  const lowerCaseApiKey = asNonEmptyString(authFile?.openai_api_key);
  if (lowerCaseApiKey) {
    return lowerCaseApiKey;
  }

  return null;
}

export function hasCodexAuth(authFile: CodexAuthFile | null): boolean {
  if (resolveApiKeyFromCodexAuthFile(authFile)) {
    return true;
  }
  return typeof authFile?.tokens?.access_token === "string" &&
    authFile.tokens.access_token.trim().length > 0;
}

export async function resolveCodexProviderLaunchConfiguration(): Promise<ProviderLaunchConfiguration | undefined> {
  const env: Record<string, string> = {};
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
  }
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
  }

  const authFile = await readCodexAuthFile();
  if (!authFile) {
    return Object.keys(env).length > 0 ? { env } : undefined;
  }

  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    files: [
      {
        placement: "home",
        path: ".codex/auth.json",
        content: JSON.stringify(authFile, null, 2),
      },
    ],
  };
}
