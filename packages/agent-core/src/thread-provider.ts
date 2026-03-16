export const THREAD_PROVIDER_IDS = ["codex", "claude-code", "pi"] as const;

export type ThreadProviderId = (typeof THREAD_PROVIDER_IDS)[number];

export const DEFAULT_THREAD_PROVIDER_ID: ThreadProviderId = "codex";

export function isThreadProviderId(value: string): value is ThreadProviderId {
  return THREAD_PROVIDER_IDS.includes(value as ThreadProviderId);
}
