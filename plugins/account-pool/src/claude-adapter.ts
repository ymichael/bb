import { z } from "zod";
import type { AccountSecret } from "./contracts.js";
import {
  importClaudeCredentials,
  type ImportedClaudeCredentials,
} from "./credentials.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  fetchOAuthRefresh,
  filterRequestHeaders,
  mountedUpstreamUrl,
} from "./provider-adapter.js";
import { isQuotaRejection, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";
import { quotaFromUsage } from "./usage.js";

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-app",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["anthropic-", "x-stainless-"];

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    expires_at: z.number().positive().optional(),
  })
  .passthrough();

const profileResponseSchema = z
  .object({
    account: z
      .object({ uuid: z.string().uuid().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export function createClaudeAdapter(options: {
  refreshUrl: string;
  usageUrl: string;
  profileUrl: string;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
}): ProviderAdapter {
  return {
    provider: "claude",
    upstreamName: "Anthropic",
    async importAccount() {
      const imported = await (
        options.importCredentials ?? importClaudeCredentials
      )();
      return {
        label: imported.email ?? "Claude Code account",
        email: imported.email,
        ...(imported.accountUuid === null
          ? {}
          : { accountUuid: imported.accountUuid }),
        subscriptionType: imported.subscriptionType,
        rateLimitTier: imported.rateLimitTier,
        secret: {
          kind: "oauth",
          accessToken: imported.accessToken,
          refreshToken: imported.refreshToken,
          expiresAt: imported.expiresAt,
        },
      };
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        family: parsed.family,
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: (account) => parsed.forAccount(account.accountUuid),
      };
    },
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(request, settings.anthropicUpstreamBaseUrl),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );
      if (secret.kind === "oauth") {
        headers.set("authorization", `Bearer ${secret.accessToken}`);
      } else {
        headers.set("x-api-key", secret.apiKey);
      }
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      const secret = context.secret;
      if (
        secret.kind !== "oauth" ||
        (!context.forceRefresh &&
          (secret.expiresAt === null ||
            secret.expiresAt > context.now() + REFRESH_WINDOW_MS))
      ) {
        return { secret, refreshed: false };
      }
      const parsed = refreshResponseSchema.parse(
        JSON.parse(
          await fetchOAuthRefresh(context, options.refreshUrl, {
            grant_type: "refresh_token",
            refresh_token: secret.refreshToken,
            client_id: OAUTH_CLIENT_ID,
          }),
        ),
      );
      const rawExpiresAt =
        parsed.expires_at ??
        (parsed.expires_in === undefined
          ? context.now() + 60 * 60 * 1_000
          : context.now() + parsed.expires_in * 1_000);
      const refreshed: AccountSecret = {
        kind: "oauth",
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? secret.refreshToken,
        expiresAt:
          rawExpiresAt < 1_000_000_000_000
            ? Math.round(rawExpiresAt * 1_000)
            : Math.round(rawExpiresAt),
        ...(secret.idToken === undefined ? {} : { idToken: secret.idToken }),
      };
      await context.accounts.writeSecret(context.account.id, refreshed);
      return { secret: refreshed, refreshed: true };
    },
    async refreshUsage(context) {
      if (context.account.kind !== "oauth") return;
      const secret = await context.freshSecret();
      if (secret.kind !== "oauth") return;
      const response = await context.fetch(options.usageUrl, {
        headers: {
          authorization: `Bearer ${secret.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (typeof payload === "object" && payload !== null) {
          const quota = quotaFromUsage(
            context.account.id,
            payload,
            context.quotas.get(context.account.id),
            context.now(),
          );
          if (quota !== null) context.quotas.put(quota);
        }
      } else {
        await response.body?.cancel();
      }
      if (context.account.accountUuid !== null) return;
      const profile = await context.fetch(options.profileUrl, {
        headers: {
          authorization: `Bearer ${secret.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (!profile.ok) {
        await profile.body?.cancel();
        return;
      }
      const parsed = profileResponseSchema.safeParse(
        await profile.json().catch(() => null),
      );
      const accountUuid = parsed.success
        ? (parsed.data.account?.uuid ?? null)
        : null;
      if (accountUuid !== null) {
        await context.accounts.setAccountUuid(context.account.id, accountUuid);
      }
    },
    errorResponse(status, message, headers) {
      const type =
        status === 401
          ? "authentication_error"
          : status === 429
            ? "rate_limit_error"
            : "api_error";
      return Response.json(
        { type: "error", error: { type, message } },
        { status, headers },
      );
    },
  };
}
