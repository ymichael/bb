import { z } from "zod";
import { parseCodexRequestBody } from "./request-body.js";
import type {
  AccountQuota,
  AccountSecret,
  LimitWindow,
  LimitWindowSlot,
} from "./contracts.js";
import {
  codexAccessTokenExpiresAt,
  importCodexCredentials,
  type ImportedCodexCredentials,
} from "./credentials.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  fetchOAuthRefresh,
  filterRequestHeaders,
  mountedUpstreamUrl,
} from "./provider-adapter.js";

export const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_CODEX_REFRESH_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
export const DEFAULT_CODEX_USAGE_URL =
  "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const USAGE_REQUEST_TIMEOUT_MS = 15_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-encoding",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "session_id",
  "thread-id",
  "user-agent",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["x-codex-", "x-stainless-"];

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
  })
  .passthrough();

function numberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetAt(headers: Headers, prefix: string, now: number): number | null {
  const raw = numberHeader(headers, `${prefix}-reset-at`);
  if (raw !== null)
    return Math.round(raw < 1_000_000_000_000 ? raw * 1_000 : raw);
  const after = numberHeader(headers, `${prefix}-reset-after-seconds`);
  return after === null ? null : now + Math.round(after * 1_000);
}

function windowMinutesFromSeconds(
  seconds: number | null | undefined,
): number | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
    return null;
  const minutes = Math.round(seconds / 60);
  return minutes > 0 ? minutes : null;
}

function previousWindow(
  previous: AccountQuota,
  slot: LimitWindowSlot,
): LimitWindow | null {
  return previous.limitWindows.find((window) => window.slot === slot) ?? null;
}

function windowFromHeaders(
  headers: Headers,
  slot: LimitWindowSlot,
  previous: LimitWindow | null,
  now: number,
): LimitWindow | null {
  const prefix = `x-codex-${slot}`;
  const usedPercent = numberHeader(headers, `${prefix}-used-percent`);
  const reset = resetAt(headers, prefix, now);
  const minutes = numberHeader(headers, `${prefix}-window-minutes`);
  const overLimit =
    headers.get(`${prefix}-over-limit`)?.toLowerCase() === "true";
  if (usedPercent === null && reset === null && !overLimit) return previous;
  const utilization =
    usedPercent === null
      ? (previous?.utilization ?? null)
      : Math.max(0, Math.min(1, usedPercent / 100));
  return {
    slot,
    windowMinutes:
      minutes !== null && minutes > 0
        ? Math.round(minutes)
        : (previous?.windowMinutes ?? null),
    utilization,
    resetAt:
      reset ??
      (previous?.resetAt !== null &&
      previous?.resetAt !== undefined &&
      previous.resetAt > now
        ? previous.resetAt
        : null),
    status:
      overLimit || (utilization !== null && utilization >= 1)
        ? "rejected"
        : null,
    observedAt: now,
    source: "header",
  };
}

function orderedWindows(
  windows: ReadonlyArray<LimitWindow | null>,
): LimitWindow[] {
  return windows.filter((window): window is LimitWindow => window !== null);
}

function withoutClaudeSlots(previous: AccountQuota): AccountQuota {
  return {
    ...previous,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
  };
}

function codexQuotaFromHeaders(
  accountId: string,
  headers: Headers,
  previous: AccountQuota,
  now: number,
): AccountQuota {
  const priorPrimary = previousWindow(previous, "primary");
  const priorSecondary = previousWindow(previous, "secondary");
  const primary = windowFromHeaders(headers, "primary", priorPrimary, now);
  const secondary = windowFromHeaders(
    headers,
    "secondary",
    priorSecondary,
    now,
  );
  if (primary === priorPrimary && secondary === priorSecondary) return previous;
  return {
    ...withoutClaudeSlots(previous),
    accountId,
    limitWindows: orderedWindows([primary, secondary]),
    observedAt: now,
    heldUntil: null,
  };
}

const usageWindowSchema = z
  .object({
    used_percent: z.number(),
    reset_at: z.number().nullish(),
    reset_after_seconds: z.number().nullish(),
    limit_window_seconds: z.number().nullish(),
  })
  .passthrough();

const usageResponseSchema = z
  .object({
    rate_limit: z
      .object({
        primary_window: usageWindowSchema.nullish(),
        secondary_window: usageWindowSchema.nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

function windowFromUsage(
  slot: LimitWindowSlot,
  value: z.infer<typeof usageWindowSchema> | null | undefined,
  now: number,
): LimitWindow | null {
  if (value === null || value === undefined) return null;
  const utilization = Math.max(0, Math.min(1, value.used_percent / 100));
  const reset =
    value.reset_at !== null &&
    value.reset_at !== undefined &&
    Number.isFinite(value.reset_at)
      ? Math.round(
          value.reset_at < 1_000_000_000_000
            ? value.reset_at * 1_000
            : value.reset_at,
        )
      : value.reset_after_seconds !== null &&
          value.reset_after_seconds !== undefined &&
          Number.isFinite(value.reset_after_seconds)
        ? now + Math.round(value.reset_after_seconds * 1_000)
        : null;
  return {
    slot,
    windowMinutes: windowMinutesFromSeconds(value.limit_window_seconds),
    utilization,
    resetAt: reset,
    status: utilization >= 1 ? "rejected" : "allowed",
    observedAt: now,
    source: "usage",
  };
}

export function codexQuotaFromUsage(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = usageResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.rate_limit == null) return null;
  return {
    ...withoutClaudeSlots(previous),
    accountId,
    limitWindows: orderedWindows([
      windowFromUsage("primary", parsed.data.rate_limit.primary_window, now),
      windowFromUsage(
        "secondary",
        parsed.data.rate_limit.secondary_window,
        now,
      ),
    ]),
    observedAt: now,
  };
}

export function createCodexAdapter(options: {
  refreshUrl: string;
  usageUrl: string;
  importCredentials?: () => Promise<ImportedCodexCredentials>;
}): ProviderAdapter {
  return {
    provider: "codex",
    upstreamName: "ChatGPT",
    async importAccount() {
      const imported = await (
        options.importCredentials ?? importCodexCredentials
      )();
      return {
        label: imported.email ?? "Codex account",
        email: imported.email,
        codexAccountId: imported.accountId,
        subscriptionType: null,
        rateLimitTier: null,
        secret: {
          kind: "oauth",
          accessToken: imported.accessToken,
          refreshToken: imported.refreshToken,
          expiresAt: imported.expiresAt,
          ...(imported.idToken === null ? {} : { idToken: imported.idToken }),
        },
      };
    },
    parseRequest(body, headers) {
      const parsed = parseCodexRequestBody(body, headers);
      return {
        family: parsed.family,
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: () => body,
      };
    },
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(request, settings.codexUpstreamBaseUrl, "v1/"),
    requestHeaders(inbound, account, secret) {
      if (secret.kind !== "oauth" || account.codexAccountId === undefined) {
        throw new Error(
          "Codex accounts require OAuth credentials and a ChatGPT account id.",
        );
      }
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );
      headers.set("authorization", `Bearer ${secret.accessToken}`);
      headers.set("chatgpt-account-id", account.codexAccountId);
      return headers;
    },
    quotaFromHeaders(accountId, headers, previous, _family, now) {
      return codexQuotaFromHeaders(accountId, headers, previous, now);
    },
    isQuotaRejection(headers) {
      return ["primary", "secondary"].some((window) => {
        const prefix = `x-codex-${window}`;
        return (
          (numberHeader(headers, `${prefix}-used-percent`) ?? 0) >= 100 ||
          headers.get(`${prefix}-over-limit`)?.toLowerCase() === "true"
        );
      });
    },
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
            client_id: CODEX_OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: secret.refreshToken,
          }),
        ),
      );
      const refreshed: AccountSecret = {
        kind: "oauth",
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? secret.refreshToken,
        ...(parsed.id_token === undefined && secret.idToken === undefined
          ? {}
          : { idToken: parsed.id_token ?? secret.idToken }),
        expiresAt: codexAccessTokenExpiresAt(parsed.access_token),
      };
      await context.accounts.writeSecret(context.account.id, refreshed);
      return { secret: refreshed, refreshed: true };
    },
    async refreshUsage(context) {
      const secret = await context.freshSecret();
      if (
        secret.kind !== "oauth" ||
        context.account.codexAccountId === undefined
      )
        return;
      const response = await context.fetch(options.usageUrl, {
        headers: {
          authorization: `Bearer ${secret.accessToken}`,
          "chatgpt-account-id": context.account.codexAccountId,
          originator: "bb",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const quota = codexQuotaFromUsage(
        context.account.id,
        await response.json().catch(() => null),
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (quota !== null) context.quotas.put(quota);
    },
    errorResponse(status, message, headers) {
      return Response.json(
        {
          error: {
            message,
            type: status === 429 ? "rate_limit_error" : "api_error",
            code: status === 429 ? "rate_limit_exceeded" : null,
          },
        },
        { status, headers },
      );
    },
  };
}
