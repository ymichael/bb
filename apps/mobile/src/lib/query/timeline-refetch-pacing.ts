import type { QueryClient, QueryKey } from "@tanstack/react-query";

const TRAILING_REFETCH_MIN_INTERVAL_MS = 50;
const TRAILING_REFETCH_MAX_INTERVAL_MS = 1_000;

export function resolveTrailingRefetchDelayMs(
  observedFetchDurationMs: number,
): number {
  return Math.min(
    TRAILING_REFETCH_MAX_INTERVAL_MS,
    Math.max(TRAILING_REFETCH_MIN_INTERVAL_MS, observedFetchDurationMs),
  );
}

const trailingRefetchCancellers = new WeakMap<
  QueryClient,
  Map<string, () => void>
>();

function scheduleKeyOf(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}

function cancellersFor(queryClient: QueryClient): Map<string, () => void> {
  let cancellers = trailingRefetchCancellers.get(queryClient);
  if (!cancellers) {
    cancellers = new Map();
    trailingRefetchCancellers.set(queryClient, cancellers);
  }
  return cancellers;
}

function hasActiveFetchingQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
): boolean {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey, type: "active" })
    .some((query) => query.state.fetchStatus !== "idle");
}

function scheduleTrailingActiveRefetch(
  queryClient: QueryClient,
  queryKey: QueryKey,
): void {
  const cancellers = cancellersFor(queryClient);
  const scheduleKey = scheduleKeyOf(queryKey);
  if (cancellers.has(scheduleKey)) return;

  const waitingSince = Date.now();
  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (hasActiveFetchingQueries(queryClient, queryKey)) return;
    unsubscribe();
    const delayMs = resolveTrailingRefetchDelayMs(Date.now() - waitingSince);
    const timer = setTimeout(() => {
      cancellers.delete(scheduleKey);
      void queryClient
        .refetchQueries({ queryKey, type: "active" }, { cancelRefetch: false })
        .catch(() => {});
    }, delayMs);
    cancellers.set(scheduleKey, () => clearTimeout(timer));
  });
  cancellers.set(scheduleKey, unsubscribe);
}

function cancelTrailingActiveRefetch(
  queryClient: QueryClient,
  queryKey: QueryKey,
): void {
  const cancellers = trailingRefetchCancellers.get(queryClient);
  if (!cancellers) return;
  const scheduleKey = scheduleKeyOf(queryKey);
  cancellers.get(scheduleKey)?.();
  cancellers.delete(scheduleKey);
  if (cancellers.size === 0) trailingRefetchCancellers.delete(queryClient);
}

export function invalidateTimelineQueryKeyPaced(
  queryClient: QueryClient,
  queryKey: QueryKey,
): void {
  const hadActiveFetch = hasActiveFetchingQueries(queryClient, queryKey);
  void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  if (hadActiveFetch) scheduleTrailingActiveRefetch(queryClient, queryKey);
}

export function invalidateTimelineQueryKeyTerminal(
  queryClient: QueryClient,
  queryKey: QueryKey,
): void {
  cancelTrailingActiveRefetch(queryClient, queryKey);
  void queryClient.cancelQueries({ queryKey });
  void queryClient.invalidateQueries({ queryKey });
}

export function disposeTrailingActiveRefetches(queryClient: QueryClient): void {
  const cancellers = trailingRefetchCancellers.get(queryClient);
  if (!cancellers) return;
  for (const cancel of cancellers.values()) cancel();
  trailingRefetchCancellers.delete(queryClient);
}
