import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const credentialsFileSchema = z
  .object({
    claudeAiOauth: z
      .object({
        accessToken: z.string().min(1),
        refreshToken: z.string().min(1),
        expiresAt: z.number().nullish(),
        subscriptionType: z.string().nullish(),
        rateLimitTier: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const accountFileSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().email().nullish(),
      accountUuid: z.string().uuid().nullish(),
    })
    .nullish(),
});

const codexAuthFileSchema = z
  .object({
    tokens: z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
        account_id: z.string().min(1).nullish(),
        id_token: z.string().min(1).nullish(),
      })
      .passthrough(),
    last_refresh: z.string().nullish(),
  })
  .passthrough();

const jwtPayloadSchema = z.record(z.string(), z.json());
type JwtPayload = z.infer<typeof jwtPayloadSchema>;
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";

export interface ImportedClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  email: string | null;
  accountUuid: string | null;
}

export interface ImportedCodexCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string;
  email: string | null;
  expiresAt: number | null;
}

function jwtPayload(token: string | null): JwtPayload | null {
  if (token === null) return null;
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const parsed = jwtPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function nestedString(
  payload: JwtPayload | null,
  claim: string,
  field: string,
): string | null {
  const nested = payload?.[claim];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested))
    return null;
  const value = nested[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function codexAccessTokenExpiresAt(token: string): number | null {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number"
    ? Math.round(payload.exp * 1_000)
    : null;
}

export function parseCodexCredentials(raw: string): ImportedCodexCredentials {
  const parsed = codexAuthFileSchema.parse(JSON.parse(raw));
  const idToken = parsed.tokens.id_token ?? null;
  const accessPayload = jwtPayload(parsed.tokens.access_token);
  const idPayload = jwtPayload(idToken);
  const accountId =
    parsed.tokens.account_id ??
    nestedString(accessPayload, CHATGPT_AUTH_CLAIM, "chatgpt_account_id") ??
    nestedString(idPayload, CHATGPT_AUTH_CLAIM, "chatgpt_account_id");
  if (accountId === null) {
    throw new Error("Codex auth tokens do not include a ChatGPT account id.");
  }
  const directEmail =
    typeof idPayload?.email === "string" ? idPayload.email : null;
  const email =
    directEmail ??
    nestedString(idPayload, CHATGPT_PROFILE_CLAIM, "email") ??
    (typeof accessPayload?.email === "string" ? accessPayload.email : null) ??
    nestedString(accessPayload, CHATGPT_PROFILE_CLAIM, "email");
  const expiresAt = codexAccessTokenExpiresAt(parsed.tokens.access_token);
  return {
    accessToken: parsed.tokens.access_token,
    refreshToken: parsed.tokens.refresh_token,
    idToken,
    accountId,
    email,
    expiresAt,
  };
}

export async function importCodexCredentials(): Promise<ImportedCodexCredentials> {
  try {
    return parseCodexCredentials(
      await fs.readFile(path.join(os.homedir(), ".codex", "auth.json"), "utf8"),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("ChatGPT account id"))
      throw error;
    throw new Error(
      "Codex OAuth credentials were not found or usable. Run `codex login` on the bb server host, then retry.",
    );
  }
}

function parseCredentials(
  raw: string,
): Omit<ImportedClaudeCredentials, "email" | "accountUuid"> | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  if (/^(?:[0-9a-f]{2})+$/iu.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, "hex").toString("utf8"));
  }
  for (const candidate of candidates) {
    try {
      const parsed = credentialsFileSchema.safeParse(JSON.parse(candidate));
      if (!parsed.success) continue;
      return {
        accessToken: parsed.data.claudeAiOauth.accessToken,
        refreshToken: parsed.data.claudeAiOauth.refreshToken,
        expiresAt: parsed.data.claudeAiOauth.expiresAt ?? null,
        subscriptionType: parsed.data.claudeAiOauth.subscriptionType ?? null,
        rateLimitTier: parsed.data.claudeAiOauth.rateLimitTier ?? null,
      };
    } catch {}
  }
  return null;
}

async function readKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const username = os.userInfo().username;
  const argumentSets = [
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username, "-w"],
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const result = await execFileAsync("security", args, { timeout: 10_000 });
      if (result.stdout.trim()) return result.stdout.trim();
    } catch {}
  }
  return null;
}

async function readAccountIdentity(): Promise<{
  email: string | null;
  accountUuid: string | null;
}> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8"),
    );
    const parsed = accountFileSchema.safeParse(value);
    return parsed.success
      ? {
          email: parsed.data.oauthAccount?.emailAddress ?? null,
          accountUuid: parsed.data.oauthAccount?.accountUuid ?? null,
        }
      : { email: null, accountUuid: null };
  } catch {
    return { email: null, accountUuid: null };
  }
}

export async function importClaudeCredentials(): Promise<ImportedClaudeCredentials> {
  const keychain = await readKeychainCredentials();
  let credentials = keychain === null ? null : parseCredentials(keychain);
  if (credentials === null) {
    try {
      credentials = parseCredentials(
        await fs.readFile(
          path.join(os.homedir(), ".claude", ".credentials.json"),
          "utf8",
        ),
      );
    } catch {}
  }
  if (credentials === null) {
    throw new Error(
      "Claude Code OAuth credentials were not found. Run `claude /login` on the bb server host, then retry.",
    );
  }
  return { ...credentials, ...(await readAccountIdentity()) };
}
