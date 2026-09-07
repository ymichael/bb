import type {
  Account,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
} from "./contracts.js";
import type { HubSettings } from "./hub.js";
import { retryAfterMilliseconds } from "./quota.js";
import type { AccountStore, QuotaStore } from "./store.js";

const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

export class TransientOAuthRefreshError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export interface AdapterSecretContext {
  account: Account;
  secret: AccountSecret;
  accounts: AccountStore;
  quotas: QuotaStore;
  fetch: typeof fetch;
  now: () => number;
  forceRefresh: boolean;
}

export interface AdapterUsageContext {
  account: Account;
  freshSecret: () => Promise<AccountSecret>;
  accounts: AccountStore;
  quotas: QuotaStore;
  fetch: typeof fetch;
  now: () => number;
}

export interface ImportedProviderAccount {
  label: string;
  email: string | null;
  accountUuid?: string;
  codexAccountId?: string;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  secret: Extract<AccountSecret, { kind: "oauth" }>;
}

export interface ProviderAdapter {
  provider: PoolProvider;
  upstreamName: string;
  importAccount(): Promise<ImportedProviderAccount>;
  parseRequest(
    body: Uint8Array,
    headers: Headers,
  ): {
    family: ModelFamily;
    affinityId: string | null;
    parentAffinityId: string | null;
    forAccount: (account: Account) => Uint8Array;
  };
  upstreamUrl(request: Request, settings: HubSettings): URL;
  requestHeaders(
    inbound: Headers,
    account: Account,
    secret: AccountSecret,
  ): Headers;
  quotaFromHeaders(
    accountId: string,
    headers: Headers,
    previous: AccountQuota,
    family: ModelFamily,
    now: number,
  ): AccountQuota;
  isQuotaRejection(headers: Headers): boolean;
  refreshSecret(
    context: AdapterSecretContext,
  ): Promise<{ secret: AccountSecret; refreshed: boolean }>;
  refreshUsage?(context: AdapterUsageContext): Promise<void>;
  errorResponse(
    status: number,
    message: string,
    headers?: HeadersInit,
  ): Response;
}

export async function fetchOAuthRefresh(
  context: Pick<AdapterSecretContext, "fetch" | "now">,
  url: string,
  body: Record<string, string>,
): Promise<string> {
  const signal = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
  let onTimeout = () => {};
  const timedOut = new Promise<never>((_resolve, reject) => {
    onTimeout = () => reject(signal.reason);
    if (signal.aborted) onTimeout();
    else signal.addEventListener("abort", onTimeout, { once: true });
  });
  try {
    let response: Response;
    try {
      response = await Promise.race([
        context
          .fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(body),
            signal,
          })
          .then((result) => {
            if (signal.aborted)
              void result.body?.cancel().catch(() => undefined);
            return result;
          }),
        timedOut,
      ]);
    } catch {
      throw new TransientOAuthRefreshError(
        "OAuth refresh failed due to a network error or timeout.",
        0,
      );
    }
    if (!response.ok) {
      const message = `OAuth refresh failed with HTTP ${response.status}.`;
      const retryAfterMs = retryAfterMilliseconds(
        response.headers.get("retry-after"),
        context.now(),
      );
      void response.body?.cancel().catch(() => undefined);
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new TransientOAuthRefreshError(message, retryAfterMs);
      }
      throw new Error(message);
    }
    try {
      return await Promise.race([response.text(), timedOut]);
    } catch {
      throw new TransientOAuthRefreshError(
        "OAuth refresh response failed due to a network error or timeout.",
        0,
      );
    }
  } finally {
    signal.removeEventListener("abort", onTimeout);
  }
}

export function filterRequestHeaders(
  inbound: Headers,
  allowed: ReadonlySet<string>,
  prefixes: readonly string[],
): Headers {
  const headers = new Headers();
  for (const [name, value] of inbound) {
    const normalized = name.toLowerCase();
    if (
      allowed.has(normalized) ||
      prefixes.some((prefix) => normalized.startsWith(prefix))
    ) {
      headers.append(name, value);
    }
  }
  return headers;
}

export function mountedUpstreamUrl(
  request: Request,
  upstreamBaseUrl: string,
  stripPrefix = "",
): URL {
  const requestUrl = new URL(request.url);
  const mountedPath = requestUrl.pathname.indexOf("/http/");
  const rawPath =
    mountedPath < 0
      ? requestUrl.pathname
      : requestUrl.pathname.slice(mountedPath + 5);
  const normalizedPath = rawPath.replace(/^\//u, "");
  const upstreamPath = normalizedPath.startsWith(stripPrefix)
    ? normalizedPath.slice(stripPrefix.length)
    : normalizedPath;
  return new URL(
    upstreamPath + requestUrl.search,
    upstreamBaseUrl.endsWith("/") ? upstreamBaseUrl : `${upstreamBaseUrl}/`,
  );
}
