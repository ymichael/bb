const SERVER_SESSION_STALE_TIME_MS = 60 * 60_000;
const FOCUS_OWNED_LIVE_STALE_TIME_MS = 30_000;
const TYPEAHEAD_STALE_TIME_MS = 15_000;

export const SESSION_STATIC_QUERY_POLICY = {
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: Infinity,
} as const;

export const SERVER_SESSION_QUERY_POLICY = {
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: SERVER_SESSION_STALE_TIME_MS,
} as const;

export const FOCUS_OWNED_LIVE_QUERY_POLICY = {
  refetchOnReconnect: true,
  refetchOnWindowFocus: true,
  staleTime: FOCUS_OWNED_LIVE_STALE_TIME_MS,
} as const;

export const RESUME_REFETCH_QUERY_POLICY = {
  refetchOnReconnect: true,
  refetchOnWindowFocus: true,
} as const;

export const TYPEAHEAD_QUERY_POLICY = {
  refetchOnWindowFocus: false,
  retry: false,
  staleTime: TYPEAHEAD_STALE_TIME_MS,
} as const;

export const EXPENSIVE_MANUAL_QUERY_POLICY = {
  refetchOnWindowFocus: false,
} as const;

export const REALTIME_OWNED_NO_FOCUS_QUERY_POLICY = {
  refetchOnWindowFocus: false,
} as const;

export const REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY = {
  staleTime: Infinity,
} as const;

export const REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY = {
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
} as const;

export const HEAVY_PAYLOAD_GC_TIME_MS = 60_000;

export const HEAVY_PAYLOAD_QUERY_POLICY = {
  gcTime: HEAVY_PAYLOAD_GC_TIME_MS,
} as const;
