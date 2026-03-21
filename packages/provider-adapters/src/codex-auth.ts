import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { ProviderLaunchConfiguration } from "@bb/core";


const codexAuthFileSchema = z.object({
  OPENAI_API_KEY: z.union([
    z.string().min(1),
    z.object({ value: z.string().min(1) }),
  ]).nullish(),
  openai_api_key: z.string().min(1).nullish(),
  tokens: z.object({
    access_token: z.string().min(1).optional(),
    account_id: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type CodexAuthFile = z.infer<typeof codexAuthFileSchema>;

let lastRawAuthJson: string | null = null;

export async function readCodexAuthFile(): Promise<CodexAuthFile | null> {
  const authPath = resolve(homedir(), ".codex", "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    const json = JSON.parse(raw) as unknown;
    const parsed = codexAuthFileSchema.safeParse(json);
    if (!parsed.success) return null;
    lastRawAuthJson = JSON.stringify(json, null, 2);
    return parsed.data;
  } catch {
    return null;
  }
}

function resolveApiKeyFromCodexAuthFile(authFile: CodexAuthFile | null): string | null {
  if (!authFile) return null;

  const apiKey = authFile.OPENAI_API_KEY;
  if (typeof apiKey === "string") return apiKey;
  if (typeof apiKey === "object" && apiKey !== null) return apiKey.value;

  return authFile.openai_api_key ?? null;
}

export function hasCodexAuth(authFile: CodexAuthFile | null): boolean {
  if (resolveApiKeyFromCodexAuthFile(authFile)) {
    return true;
  }
  return !!authFile?.tokens?.access_token;
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
        content: lastRawAuthJson ?? JSON.stringify(authFile, null, 2),
      },
    ],
  };
}
