import type {
  Account,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./contracts.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ImportedProviderAccount } from "./provider-adapter.js";
import { TransientOAuthRefreshError } from "./provider-adapter.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import {
  accountStatus,
  governingWeeklyResetAt,
  isQuotaExhausted,
  isSharedQuotaExhausted,
  retryAfterMilliseconds,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";

const ROUTE = "/api/v1/plugins/account-pool/http";
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_INLINE_HOLD_MS = 20_000;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const AFFINITY_IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_AFFINITY_BINDINGS = 4_096;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface HubSettings {
  anthropicUpstreamBaseUrl: string;
  codexUpstreamBaseUrl: string;
  switchThreshold: number;
}

interface HubOptions {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  getSettings: () => HubSettings;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  usageRefreshIntervalMs: number;
  drainTimeoutMs: number;
  onAccountsChanged: () => void;
}

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  accept: () => void;
}

interface ActiveAccount {
  accountId: string;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
}
interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

export class AccountPoolHub {
  private accepting = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  private readonly usageRefreshes = new Map<string, Promise<void>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();

  constructor(private readonly options: HubOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    this.stopped = new AbortController();
    this.accepting = true;
    while (!signal.aborted) {
      await this.refreshUsage();
      await waitForDelay(this.options.usageRefreshIntervalMs, signal);
    }
    await this.stop();
  }

  async authenticate(request: Request): Promise<string | null> {
    const token =
      request.headers.get("x-bb-account-pool-token") ??
      readBearer(request.headers.get("authorization"));
    return this.options.hubTokens.authenticate(token);
  }

  async importAccount(
    provider: PoolProvider,
  ): Promise<ImportedProviderAccount> {
    return this.adapter(provider).importAccount();
  }

  async handle(request: Request, provider: PoolProvider): Promise<Response> {
    const adapter = this.adapter(provider);
    const hostId = await this.authenticate(request);
    if (hostId === null) {
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    }
    return this.handleAuthenticated(request, provider, hostId);
  }

  async handleAuthenticated(
    request: Request,
    provider: PoolProvider,
    hostId: string | null = null,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    return this.forward(
      request,
      new Uint8Array(await request.arrayBuffer()),
      adapter,
      hostId,
    );
  }

  async refreshUsage(accountId?: string, force = false): Promise<void> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );
    await Promise.all(
      accounts.map((account) => this.refreshAccountUsage(account, force)),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    force: boolean,
  ): Promise<void> {
    const adapter = this.adapter(account.provider);
    if (
      adapter.refreshUsage === undefined ||
      (this.inFlightByAccount.get(account.id) ?? 0) > 0
    )
      return;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (
      !force &&
      last !== undefined &&
      now - last < this.options.usageRefreshIntervalMs
    )
      return;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    this.lastUsageRefreshAt.set(account.id, now);
    const refresh = adapter
      .refreshUsage({
        account,
        freshSecret: () =>
          this.freshSecret(account, adapter, { kind: "normal" }),
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: this.options.fetch,
        now: this.options.now,
      })
      .catch(() => undefined)
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));
    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    if (this.inFlightCount() === 0) return;
    for (const controller of this.activeControllers) {
      controller.abort(
        new Error(
          "Account Pooler stopped before the upstream response completed.",
        ),
      );
    }
  }

  async status(): Promise<
    Omit<PoolStatus, "routedThreadsWithoutLocalLogin" | "routing">
  > {
    const settings = this.options.getSettings();
    const now = this.options.now();
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        return {
          ...account,
          lastUsedHostName: null,
          fiveHourUtilization: quota.fiveHourUtilization,
          fiveHourResetAt: quota.fiveHourResetAt,
          fiveHourStatus: quota.fiveHourStatus,
          sevenDayUtilization: quota.sevenDayUtilization,
          sevenDayResetAt: quota.sevenDayResetAt,
          sevenDayStatus: quota.sevenDayStatus,
          representativeClaim: quota.representativeClaim,
          familyWeekly: quota.familyWeekly,
          limitWindows: quota.limitWindows,
          observedAt: quota.observedAt,
          heldUntil: quota.heldUntil,
          error: quota.error,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          status: accountStatus(account, quota, settings.switchThreshold, now),
        };
      }),
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    hostId: string | null,
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === adapter.provider,
    );
    const candidateIds = new Set(accounts.map((account) => account.id));
    const parsed = adapter.parseRequest(body, request.headers);
    const family = parsed.family;
    const affinityKey =
      hostId === null || parsed.affinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.affinityId]);
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.parentAffinityId]);
    try {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();
        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          signal,
        );
        if (selected === null) break;
        const heldMs = (selected.quota.heldUntil ?? 0) - this.options.now();
        if (heldMs > 0) {
          if (heldMs > MAX_INLINE_HOLD_MS || waited.has(selected.account.id)) {
            failure = {
              status: 429,
              message:
                "The current Account Pooler account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };
            if (selected.keepAffinity)
              return adapter.errorResponse(
                failure.status,
                failure.message,
                failure.headers,
              );
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          }
          waited.add(selected.account.id);
          await waitForDelay(heldMs, signal);
          continue;
        }
        previousAccountId = selected.account.id;
        attempted.add(selected.account.id);
        if (hostId !== null) {
          const changed = await this.options.accounts.recordUsed(
            selected.account.id,
            this.options.now(),
            hostId,
          );
          if (changed) this.options.onAccountsChanged();
        }
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.markError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        let authRetried = false;
        let paced = waited.has(selected.account.id);
        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;
          try {
            upstream = await this.fetchUpstream(
              request,
              parsed.forAccount(selected.account),
              selected.account,
              secret,
              adapter,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            break;
          }
          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const observed = adapter.quotaFromHeaders(
            selected.account.id,
            response.headers,
            this.options.quotas.get(selected.account.id),
            family,
            this.options.now(),
          );
          this.options.quotas.put(observed);
          if (response.status === 429) {
            if (adapter.isQuotaRejection(response.headers)) {
              await this.discardUpstream(upstream, false);
              break;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            this.options.quotas.put({
              ...observed,
              heldUntil: this.options.now() + waitMs,
            });
            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              await this.discardUpstream(upstream, false);
              await waitForDelay(waitMs, signal);
              continue;
            }
            if (!selected.keepAffinity) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            if (
              response.status === 401 &&
              secret.kind === "oauth" &&
              !authRetried
            ) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  await this.markAuthError(
                    selected.account,
                    secret,
                    errorMessage(error),
                    signal,
                  );
                }
                break;
              }
              continue;
            }
            if (response.status === 401 || response.status === 403) {
              await this.markAuthError(
                selected.account,
                secret,
                failure.message,
                signal,
              );
            }
            break;
          }
          if (response.ok) selected.accept();
          return this.clientResponse(upstream);
        }
      }
      signal.throwIfAborted();
      return failure === null
        ? this.noEligibleResponse(accounts, family, adapter)
        : adapter.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;
      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    }
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async markAuthError(
    account: Account,
    rejected: AccountSecret,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      this.markError(account.id, message);
      return;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff?.kind === "rejected" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              this.markError(account.id, message);
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const available = accounts
      .filter((account) => account.provider === provider && account.enabled)
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(({ quota }) => quota.error === null)
      .filter(({ quota }) => !isSharedQuotaExhausted(quota, threshold, now));
    const eligible = available.filter(
      ({ quota }) => !isQuotaExhausted(quota, family, threshold, now),
    );
    const unattempted = eligible.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );
    const candidates = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? eligible.find(({ account }) => account.id === boundAccountId)
        : undefined;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = unattempted.find(
          ({ account }) => account.id === parent.accountId,
        );
      }
    }
    let active = this.activeAccounts.get(provider);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];
    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);
    const selected =
      bound !== undefined && unattempted.includes(bound)
        ? bound
        : (inherited ??
          (boundAccountId === null &&
          previousAccountId === null &&
          activeAccount !== undefined &&
          unattempted.includes(activeAccount)
            ? activeAccount
            : next) ??
          null);
    if (selected === null) return null;
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > MAX_AFFINITY_BINDINGS) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    if (active === undefined) {
      active = { accountId: selected.account.id };
      this.activeAccounts.set(provider, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(({ account }) => account.id === accountId) &&
      !eligible.some(({ account }) => account.id === accountId);
    const rebind =
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding && attempted.has(bound.account.id)));
    const advance =
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)));
    return {
      ...selected,
      keepAffinity: selected.account.id === routing.pinnedAccountId,
      accept: () => {
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(provider, selected.account.id);
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        if (existing.kind === "rejection-check") {
          await existing.result;
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind === "rejected"
        )
          continue;
        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const error = this.options.quotas.get(account.id).error;
            if (error !== null) throw new Error(error);
            if (
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind === "rejected")
            ) {
              if (
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                const quota = this.options.quotas.get(account.id);
                this.options.quotas.put({ ...quota, error: null });
              }
              return result.secret;
            } catch (error) {
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
  ): Promise<UpstreamResult> {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);
    this.increment(account.id);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      request.signal.removeEventListener("abort", abortFromRequest);
      this.activeControllers.delete(controller);
      this.decrement(account.id);
    };
    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(request, this.options.getSettings());
      const headers = adapter.requestHeaders(request.headers, account, secret);
      const response = await this.options
        .fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        })
        .catch(() => {
          throw new UpstreamConnectionError("Upstream connection failed.");
        });
      return { response, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(upstream: UpstreamResult): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            upstream.release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          upstream.release();
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Account Pooler has no enabled account",
      );
    }
    const now = this.options.now();
    const next = accounts
      .filter((account) => account.enabled)
      .flatMap((account) => {
        const quota = this.options.quotas.get(account.id);
        return [
          quota.heldUntil,
          quota.fiveHourResetAt,
          quota.sevenDayResetAt,
          ...quota.limitWindows.map((window) => window.resetAt),
          governingWeeklyResetAt(quota, family),
        ].filter((value): value is number => value !== null && value > now);
      })
      .sort((left, right) => left - right)[0];
    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );
    return adapter.errorResponse(
      429,
      "No Account Pooler account is currently eligible.",
      { "retry-after": String(retryAfter) },
    );
  }

  private markError(accountId: string, message: string): void {
    const quota = this.options.quotas.get(accountId);
    this.options.quotas.put({ ...quota, error: message.slice(0, 1_000) });
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  getSettings: () => HubSettings;
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  importClaudeCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  usageUrl?: string;
  profileUrl?: string;
  usageRefreshIntervalMs?: number;
  drainTimeoutMs?: number;
  onAccountsChanged?: () => void;
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
        importCredentials: options.importClaudeCredentials,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        importCredentials: options.importCodexCredentials,
      }),
    ],
  ]);
  return new AccountPoolHub({
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    hubTokens: options.hubTokens,
    getSettings: options.getSettings,
    adapters,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    usageRefreshIntervalMs:
      options.usageRefreshIntervalMs ?? DEFAULT_USAGE_REFRESH_INTERVAL_MS,
    drainTimeoutMs: options.drainTimeoutMs ?? 60_000,
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
  });
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
