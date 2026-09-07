import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Account } from "./contracts.js";

const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const OAUTH_BETA = "oauth-2025-04-20";
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1_000;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().positive(),
  })
  .passthrough();

const profileResponseSchema = z
  .object({
    account: z
      .object({
        uuid: z.string().uuid().nullish(),
        email: z.string().email().nullish(),
        display_name: z.string().trim().min(1).nullish(),
        has_claude_max: z.boolean().nullish(),
        has_claude_pro: z.boolean().nullish(),
        subscription_type: z.string().trim().min(1).nullish(),
        rate_limit_tier: z.string().trim().min(1).nullish(),
      })
      .passthrough(),
    organization: z
      .object({
        name: z.string().trim().min(1).nullish(),
        organization_type: z.string().trim().min(1).nullish(),
        rate_limit_tier: z.string().trim().min(1).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

interface LoginSession {
  sessionId: string;
  codeVerifier: string;
  state: string;
  createdAt: number;
}

export interface ClaudeOAuthAccount {
  label: string;
  email: string | null;
  accountUuid: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ClaudeOAuthLoginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  authorizeUrl?: string;
  tokenUrl?: string;
  profileUrl?: string;
  addAccount: (authenticated: ClaudeOAuthAccount) => Promise<Account>;
}

export interface OAuthLoginStart {
  sessionId: string;
  authorizeUrl: string;
}

export interface OAuthLoginComplete {
  sessionId: string;
  pasted: string;
}

export function parseManualCode(
  pasted: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = pasted.trim();
  if (trimmed.length === 0) throw new Error("Paste the authorization code.");
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code !== null) {
      if (state !== null && state !== expectedState) {
        throw new Error("OAuth state mismatch. Start again.");
      }
      return { code, state: state ?? expectedState };
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "OAuth state mismatch. Start again."
    ) {
      throw error;
    }
  }
  const separator = trimmed.indexOf("#");
  if (separator >= 0) {
    const code = trimmed.slice(0, separator).trim();
    const state = trimmed.slice(separator + 1).trim();
    if (code.length === 0) throw new Error("Paste the authorization code.");
    if (state.length > 0 && state !== expectedState) {
      throw new Error("OAuth state mismatch. Start again.");
    }
    return { code, state: state.length > 0 ? state : expectedState };
  }
  return { code: trimmed, state: expectedState };
}

export class ClaudeOAuthLogin {
  private session: LoginSession | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly profileUrl: string;

  constructor(private readonly options: ClaudeOAuthLoginOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.authorizeUrl = options.authorizeUrl ?? OAUTH_AUTHORIZE_URL;
    this.tokenUrl = options.tokenUrl ?? OAUTH_TOKEN_URL;
    this.profileUrl = options.profileUrl ?? OAUTH_PROFILE_URL;
  }

  start(): OAuthLoginStart {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    this.session = {
      sessionId,
      codeVerifier,
      state,
      createdAt: this.now(),
    };
    const authorizeUrl = new URL(this.authorizeUrl);
    authorizeUrl.searchParams.set("code", "true");
    authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", OAUTH_SCOPES);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    return { sessionId, authorizeUrl: authorizeUrl.toString() };
  }

  async complete(input: OAuthLoginComplete): Promise<Account> {
    const session = this.session;
    if (session === null || session.sessionId !== input.sessionId) {
      throw new Error("Login session was not found. Start again.");
    }
    this.session = null;
    if (this.now() - session.createdAt >= LOGIN_SESSION_TTL_MS) {
      throw new Error("Code expired, start again.");
    }
    const parsed = parseManualCode(input.pasted, session.state);
    const tokenResponse = await this.fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: parsed.code,
        state: parsed.state,
        code_verifier: session.codeVerifier,
        redirect_uri: OAUTH_REDIRECT_URI,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      throw new Error(
        `Claude token exchange failed (HTTP ${tokenResponse.status}). Start again.`,
      );
    }
    const tokenPayload = await tokenResponse.json().catch(() => null);
    const parsedTokens = tokenResponseSchema.safeParse(tokenPayload);
    if (!parsedTokens.success) {
      throw new Error(
        "Claude token exchange returned an invalid response. Start again.",
      );
    }
    const tokens = parsedTokens.data;
    const profileResponse = await this.fetch(this.profileUrl, {
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "anthropic-beta": OAUTH_BETA,
      },
    });
    if (!profileResponse.ok) {
      await profileResponse.body?.cancel();
      throw new Error(
        `Claude profile lookup failed (HTTP ${profileResponse.status}). Start again.`,
      );
    }
    const profilePayload = await profileResponse.json().catch(() => null);
    const parsedProfile = profileResponseSchema.safeParse(profilePayload);
    if (!parsedProfile.success) {
      throw new Error(
        "Claude profile lookup returned an invalid response. Start again.",
      );
    }
    const profile = parsedProfile.data;
    const email = profile.account.email ?? null;
    const subscriptionType = profile.account.has_claude_max
      ? "max"
      : profile.account.has_claude_pro
        ? "pro"
        : (profile.account.subscription_type ??
          profile.organization?.organization_type ??
          null);
    return this.options.addAccount({
      label:
        profile.account.display_name ??
        email ??
        profile.organization?.name ??
        "Claude account",
      email,
      accountUuid: profile.account.uuid ?? null,
      subscriptionType,
      rateLimitTier:
        profile.account.rate_limit_tier ??
        profile.organization?.rate_limit_tier ??
        null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: this.now() + tokens.expires_in * 1_000,
    });
  }
}
