import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  getCloudAuthProvider,
  listCloudAuthProviders,
  type CloudAuthProviderId,
} from "@bb/agent-providers";

const HTTP_TIMEOUT_MS = 30_000;
const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const SAFE_PROVIDER_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const CLAUDE_CALLBACK_CONFIG = {
  errorTitle: "Claude authentication failed",
  listenHost: "127.0.0.1",
  path: "/callback",
  port: 53_692,
  redirectUri: "http://localhost:53692/callback",
  successTitle: "Claude authentication completed",
} as const;
const CODEX_CALLBACK_CONFIG = {
  errorTitle: "Codex authentication failed",
  listenHost: "127.0.0.1",
  path: "/auth/callback",
  port: 1_455,
  redirectUri: "http://localhost:1455/auth/callback",
  successTitle: "Codex authentication completed",
} as const;

const claudeTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1),
    scope: z.string().optional(),
  })
  .passthrough();

const claudeProfileSchema = z
  .object({
    account: z
      .object({
        email: z.string().min(1),
        uuid: z.string().min(1),
      })
      .optional(),
    organization: z
      .object({
        name: z.string().min(1),
        organization_type: z.string().min(1),
        uuid: z.string().min(1),
      })
      .optional(),
  })
  .passthrough();

const codexJwtPayloadSchema = z
  .object({
    [OPENAI_JWT_CLAIM_PATH]: z
      .object({
        chatgpt_account_id: z.string().min(1).optional(),
      })
      .optional(),
  })
  .passthrough();

const codexIdTokenPayloadSchema = z
  .object({
    email: z.string().email().optional(),
  })
  .passthrough();

const codexTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    id_token: z.string().min(1).optional(),
    refresh_token: z.string().min(1),
  })
  .passthrough();

const providerErrorBodySchema = z
  .object({
    error: z.union([
      z.string(),
      z.object({
        code: z.string().optional(),
        type: z.string().optional(),
      }).passthrough(),
    ]).optional(),
  })
  .passthrough();

function formatOAuthAuthorizationUrl(url: URL): string {
  return url.toString().replaceAll("+", "%20");
}

export const claudeSubscriptionTypeSchema = z
  .enum(["enterprise", "max", "pro", "team"])
  .nullable();
export type ClaudeSubscriptionType = z.infer<
  typeof claudeSubscriptionTypeSchema
>;

export const codexStoredCredentialSchema = z
  .object({
    accessToken: z.string().min(1),
    accountId: z.string().min(1).nullable(),
    expiresAt: z.number().int().positive(),
    idToken: z.string().min(1).nullable(),
    providerId: z.literal("codex"),
    refreshToken: z.string().min(1),
  })
  .strict();
export type CodexStoredCredential = z.infer<typeof codexStoredCredentialSchema>;

export const claudeStoredCredentialSchema = z
  .object({
    accessToken: z.string().min(1),
    accountEmail: z.string().min(1).nullable(),
    accountId: z.string().min(1).nullable(),
    expiresAt: z.number().int().positive(),
    providerId: z.literal("claude-code"),
    refreshToken: z.string().min(1),
    scopes: z.array(z.string()),
    subscriptionType: claudeSubscriptionTypeSchema,
  })
  .strict();
export type ClaudeStoredCredential = z.infer<typeof claudeStoredCredentialSchema>;

export const storedCloudAuthCredentialSchema = z.discriminatedUnion("providerId", [
  claudeStoredCredentialSchema,
  codexStoredCredentialSchema,
]);
export type StoredCloudAuthCredential = z.infer<
  typeof storedCloudAuthCredentialSchema
>;

export interface CloudAuthAuthorizationFlow {
  authorizationUrl: string;
  state: string;
  verifier: string;
}

export interface ExchangeCloudAuthCodeArgs {
  code: string;
  state: string;
  verifier: string;
}

export interface RefreshCloudAuthCredentialArgs<
  TCredential extends StoredCloudAuthCredential,
> {
  credential: TCredential;
}

export interface CloudAuthProviderDefinition<
  TCredential extends StoredCloudAuthCredential,
> {
  callback: {
    errorTitle: string;
    listenHost: string;
    path: string;
    port: number;
    redirectUri: string;
    successTitle: string;
  };
  createAuthorizationFlow(): Promise<CloudAuthAuthorizationFlow>;
  displayName: string;
  exchangeCode(args: ExchangeCloudAuthCodeArgs): Promise<TCredential>;
  getConnectionLabel(credential: TCredential): string | null;
  id: TCredential["providerId"];
  refreshCredential(
    args: RefreshCloudAuthCredentialArgs<TCredential>,
  ): Promise<TCredential>;
}

function createPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function createOAuthState(): string {
  return randomBytes(16).toString("hex");
}

function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function extractProviderErrorCode(raw: string): string | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = providerErrorBodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const errorField = parsed.data.error;
  if (typeof errorField === "string") {
    return SAFE_PROVIDER_ERROR_CODE_PATTERN.test(errorField) ? errorField : null;
  }
  if (!errorField) {
    return null;
  }

  const candidates = [errorField.code, errorField.type];
  for (const candidate of candidates) {
    if (candidate && SAFE_PROVIDER_ERROR_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseJsonResponseBody<TValue>(
  args: {
    action: string;
    raw: string;
    schema: z.ZodSchema<TValue>;
  },
): TValue {
  try {
    const parsedJson = JSON.parse(args.raw);
    return args.schema.parse(parsedJson);
  } catch {
    throw new Error(`${args.action} returned an invalid response`);
  }
}

async function readJsonResponse<TValue>(
  response: Response,
  schema: z.ZodSchema<TValue>,
  action: string,
): Promise<TValue> {
  const raw = await response.text();
  if (!response.ok) {
    const code = extractProviderErrorCode(raw);
    throw new Error(
      code
        ? `${action} failed with ${response.status} (${code})`
        : `${action} failed with ${response.status}`,
    );
  }

  return parseJsonResponseBody({
    action,
    raw,
    schema,
  });
}

function mapClaudeOrganizationTypeToSubscription(
  organizationType: string | null,
): ClaudeSubscriptionType {
  switch (organizationType) {
    case "claude_enterprise":
      return "enterprise";
    case "claude_max":
      return "max";
    case "claude_pro":
      return "pro";
    case "claude_team":
      return "team";
    default:
      return null;
  }
}

function decodeCodexAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const rawPayload = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const payload = codexJwtPayloadSchema.parse(JSON.parse(rawPayload));
    return payload[OPENAI_JWT_CLAIM_PATH]?.chatgpt_account_id ?? null;
  } catch {
    return null;
  }
}

function decodeCodexAccountEmail(idToken: string | null): string | null {
  if (!idToken) {
    return null;
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const rawPayload = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const payload = codexIdTokenPayloadSchema.parse(JSON.parse(rawPayload));
    return payload.email ?? null;
  } catch {
    return null;
  }
}

async function fetchClaudeProfile(
  accessToken: string,
): Promise<z.infer<typeof claudeProfileSchema> | null> {
  const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "GET",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    return null;
  }

  const raw = await response.text();
  return parseJsonResponseBody({
    action: "Claude OAuth profile fetch",
    raw,
    schema: claudeProfileSchema,
  });
}

const claudeProviderDefinition: CloudAuthProviderDefinition<ClaudeStoredCredential> = {
  callback: CLAUDE_CALLBACK_CONFIG,
  async createAuthorizationFlow() {
    const verifier = createPkceVerifier();
    const challenge = createPkceChallenge(verifier);
    const state = createOAuthState();
    const url = new URL("https://claude.ai/oauth/authorize");
    url.searchParams.set("code", "true");
    url.searchParams.set(
      "client_id",
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", CLAUDE_CALLBACK_CONFIG.redirectUri);
    url.searchParams.set(
      "scope",
      [
        "org:create_api_key",
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
        "user:file_upload",
      ].join(" "),
    );
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    return {
      authorizationUrl: formatOAuthAuthorizationUrl(url),
      state,
      verifier,
    };
  },
  displayName: getCloudAuthProvider("claude-code").displayName,
  async exchangeCode(args) {
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      body: JSON.stringify({
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        code: args.code,
        code_verifier: args.verifier,
        grant_type: "authorization_code",
        redirect_uri: CLAUDE_CALLBACK_CONFIG.redirectUri,
        state: args.state,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const tokenResponse = await readJsonResponse(
      response,
      claudeTokenResponseSchema,
      "Claude OAuth token exchange",
    );
    const profile = await fetchClaudeProfile(tokenResponse.access_token);

    return {
      accessToken: tokenResponse.access_token,
      accountEmail: profile?.account?.email ?? null,
      accountId: profile?.account?.uuid ?? null,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      providerId: "claude-code",
      refreshToken: tokenResponse.refresh_token,
      scopes:
        tokenResponse.scope?.split(" ").filter((scope) => scope.length > 0) ?? [],
      subscriptionType: mapClaudeOrganizationTypeToSubscription(
        profile?.organization?.organization_type ?? null,
      ),
    };
  },
  getConnectionLabel(credential) {
    return credential.accountEmail ?? credential.accountId ?? null;
  },
  id: "claude-code",
  async refreshCredential(args) {
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      body: JSON.stringify({
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        grant_type: "refresh_token",
        refresh_token: args.credential.refreshToken,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const tokenResponse = await readJsonResponse(
      response,
      claudeTokenResponseSchema,
      "Claude OAuth refresh",
    );
    const profile = await fetchClaudeProfile(tokenResponse.access_token);

    return {
      accessToken: tokenResponse.access_token,
      accountEmail: profile?.account?.email ?? args.credential.accountEmail,
      accountId: profile?.account?.uuid ?? args.credential.accountId,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      providerId: "claude-code",
      refreshToken: tokenResponse.refresh_token,
      scopes:
        tokenResponse.scope?.split(" ").filter((scope) => scope.length > 0)
        ?? args.credential.scopes,
      subscriptionType: mapClaudeOrganizationTypeToSubscription(
        profile?.organization?.organization_type ?? null,
      ),
    };
  },
};

const codexProviderDefinition: CloudAuthProviderDefinition<CodexStoredCredential> = {
  callback: CODEX_CALLBACK_CONFIG,
  async createAuthorizationFlow() {
    const verifier = createPkceVerifier();
    const challenge = createPkceChallenge(verifier);
    const state = createOAuthState();
    const url = new URL("https://auth.openai.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "app_EMoamEEZ73f0CkXaXp7hrann");
    url.searchParams.set("redirect_uri", CODEX_CALLBACK_CONFIG.redirectUri);
    url.searchParams.set("scope", "openid profile email offline_access");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "pi");

    return {
      authorizationUrl: formatOAuthAuthorizationUrl(url),
      state,
      verifier,
    };
  },
  displayName: getCloudAuthProvider("codex").displayName,
  async exchangeCode(args) {
    const response = await fetch("https://auth.openai.com/oauth/token", {
      body: new URLSearchParams({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: args.code,
        code_verifier: args.verifier,
        grant_type: "authorization_code",
        redirect_uri: CODEX_CALLBACK_CONFIG.redirectUri,
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const tokenResponse = await readJsonResponse(
      response,
      codexTokenResponseSchema,
      "Codex OAuth token exchange",
    );

    return {
      accessToken: tokenResponse.access_token,
      accountId: decodeCodexAccountId(tokenResponse.access_token),
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      idToken: tokenResponse.id_token ?? null,
      providerId: "codex",
      refreshToken: tokenResponse.refresh_token,
    };
  },
  getConnectionLabel(credential) {
    return decodeCodexAccountEmail(credential.idToken) ?? credential.accountId;
  },
  id: "codex",
  async refreshCredential(args) {
    const response = await fetch("https://auth.openai.com/oauth/token", {
      body: new URLSearchParams({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: args.credential.refreshToken,
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const tokenResponse = await readJsonResponse(
      response,
      codexTokenResponseSchema,
      "Codex OAuth refresh",
    );

    return {
      accessToken: tokenResponse.access_token,
      accountId:
        decodeCodexAccountId(tokenResponse.access_token)
        ?? args.credential.accountId,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      idToken: tokenResponse.id_token ?? args.credential.idToken,
      providerId: "codex",
      refreshToken: tokenResponse.refresh_token,
    };
  },
};

const cloudAuthProviderDefinitions = {
  "claude-code": claudeProviderDefinition,
  codex: codexProviderDefinition,
} satisfies Record<
  CloudAuthProviderId,
  CloudAuthProviderDefinition<StoredCloudAuthCredential>
>;

export function getCloudAuthProviderDefinition<TProviderId extends CloudAuthProviderId>(
  providerId: TProviderId,
): (typeof cloudAuthProviderDefinitions)[TProviderId] {
  return cloudAuthProviderDefinitions[providerId];
}

function matchStoredCloudAuthCredential<TResult>(
  args: {
    credential: StoredCloudAuthCredential;
    onClaude(credential: ClaudeStoredCredential): TResult;
    onCodex(credential: CodexStoredCredential): TResult;
  },
): TResult {
  switch (args.credential.providerId) {
    case "claude-code":
      return args.onClaude(args.credential);
    case "codex":
      return args.onCodex(args.credential);
  }
}

export function listCloudAuthProviderDefinitions() {
  return listCloudAuthProviders().map((provider) =>
    cloudAuthProviderDefinitions[provider.id]
  );
}

export function getCloudAuthConnectionLabel(
  credential: StoredCloudAuthCredential,
): string | null {
  return matchStoredCloudAuthCredential({
    credential,
    onClaude: (claudeCredential) =>
      getCloudAuthProviderDefinition("claude-code").getConnectionLabel(
        claudeCredential,
      ),
    onCodex: (codexCredential) =>
      getCloudAuthProviderDefinition("codex").getConnectionLabel(
        codexCredential,
      ),
  });
}

export async function refreshStoredCloudAuthCredential(
  args: RefreshCloudAuthCredentialArgs<StoredCloudAuthCredential>,
): Promise<StoredCloudAuthCredential> {
  return matchStoredCloudAuthCredential<Promise<StoredCloudAuthCredential>>({
    credential: args.credential,
    onClaude: (credential) =>
      getCloudAuthProviderDefinition("claude-code").refreshCredential({
        credential,
      }),
    onCodex: (credential) =>
      getCloudAuthProviderDefinition("codex").refreshCredential({
        credential,
      }),
  });
}
