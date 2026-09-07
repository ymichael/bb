import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";

/**
 * How long after a reported reset to actually retry.
 *
 * Providers report the reset of a window they are still enforcing, and clocks
 * disagree, so retrying at exactly `resetsAtMs` reliably earns a second 429.
 */
export const RESET_BUFFER_MS = 15_000;

/**
 * Spread added on top of the buffer.
 *
 * Every thread blocked on one account hears about the same reset, so without
 * this they would all retry in the same instant and re-exhaust the window
 * together. This is the only thing spreading them out — nothing tracks which
 * accounts are exhausted, by design — so the queued retries have to disagree
 * about when to wake rather than take turns.
 */
export const RESET_JITTER_MS = 30_000;

export const DEFAULT_MAXIMUM_WAIT_MS = 6 * 60 * 60 * 1_000;

export const OVERLOAD_RETRY_BASE_MS = 5_000;

/**
 * The cap on a turn's TOTAL attempts: the original dispatch plus at most four
 * retries, since `attemptNumber` counts from 1 on the original.
 *
 * A provider that keeps reporting a window that never moves would otherwise
 * retry forever, one queued row at a time. The old scheduler prevented that by
 * remembering every window it had attempted in process memory, which a restart
 * erased; the attempt number rides the turn itself, so this cap survives one.
 */
export const MAX_RETRY_ATTEMPTS = 5;

export type RetryDeclineReason =
  | "not-retryable"
  | "no-rate-limit-state"
  | "not-resettable"
  | "beyond-maximum-wait"
  | "attempts-exhausted";

export type RetryDecision =
  | { kind: "decline"; reason: RetryDeclineReason }
  | {
      kind: "retry";
      sendAt: number;
      reason: "Rate limited" | "Provider overloaded";
    };

export interface RetryPolicyInput {
  failure: PluginTurnFailedEvent;
  /** Null means "no limit": wait however long the provider says. */
  maximumWaitMs: number | null;
  now: number;
  /** In [0, 1). Injected so tests can pin the jitter. */
  random: number;
}

/**
 * When the blocked windows in a snapshot release.
 *
 * The LATEST blocked window wins: a snapshot can report a five-hour window and
 * a weekly one at once, and retrying when the five-hour window opens while the
 * weekly one is still blocked just fails again.
 */
export function blockedWindowResetAtMs(
  rateLimits: NonNullable<PluginTurnFailedEvent["rateLimits"]>,
): number | null {
  const blocked = rateLimits.windows.filter(
    (window) => window.status === "blocked",
  );
  const relevant = blocked.length > 0 ? blocked : rateLimits.windows;
  const resets = relevant.flatMap((window) =>
    window.resetsAtMs === null ? [] : [window.resetsAtMs],
  );
  return resets.length === 0 ? null : Math.max(...resets);
}

/** When to wake for a reset, buffered and jittered, never in the past. */
export function sendAtMs(args: {
  resetsAtMs: number;
  now: number;
  random: number;
}): number {
  const base = Math.max(args.resetsAtMs, args.now);
  return base + RESET_BUFFER_MS + Math.floor(args.random * RESET_JITTER_MS);
}

export function overloadedSendAtMs(args: {
  attemptNumber: number;
  now: number;
  random: number;
}): number {
  const delay = OVERLOAD_RETRY_BASE_MS * 2 ** (args.attemptNumber - 1);
  return args.now + delay + Math.floor(args.random * delay);
}

/**
 * Whether this failure earns a retry, and when.
 *
 * Deliberately pure and total: every decline names its reason so the caller can
 * say why nothing was scheduled, which used to require reading the plugin's
 * debug log.
 *
 * The eligibility rules are the ones the log-replay classifier applied, minus
 * the ones core now answers. It no longer has to prove the turn really failed,
 * pair requests with completions, or check that a newer user action has not
 * superseded the turn: `turn.failed` is announced once, for the turn that
 * failed, with the failure facts attached.
 */
export function decideRetry(input: RetryPolicyInput): RetryDecision {
  const { failure } = input;
  if (failure.attemptNumber >= MAX_RETRY_ATTEMPTS) {
    return { kind: "decline", reason: "attempts-exhausted" };
  }
  if (failure.errorInfo?.category === "overloaded") {
    return {
      kind: "retry",
      sendAt: overloadedSendAtMs({
        attemptNumber: failure.attemptNumber,
        now: input.now,
        random: input.random,
      }),
      reason: "Provider overloaded",
    };
  }
  if (failure.errorInfo?.category !== "rate-limit") {
    return { kind: "decline", reason: "not-retryable" };
  }
  const rateLimits = failure.rateLimits;
  if (rateLimits === null || rateLimits.status !== "blocked") {
    // The error said rate limit but the provider's own accounting disagrees,
    // so there is no window to wait for and guessing one would be a blind
    // retry against a limit we cannot see.
    return { kind: "decline", reason: "no-rate-limit-state" };
  }
  const resetsAtMs = blockedWindowResetAtMs(rateLimits);
  // Credit and spend-control limits do not reset on a clock — waiting does not
  // fix them, paying does — so only a subscription window earns a timer.
  if (rateLimits.kind !== "subscription-window" || resetsAtMs === null) {
    return { kind: "decline", reason: "not-resettable" };
  }
  if (
    input.maximumWaitMs !== null &&
    resetsAtMs - input.now > input.maximumWaitMs
  ) {
    return { kind: "decline", reason: "beyond-maximum-wait" };
  }
  return {
    kind: "retry",
    sendAt: sendAtMs({
      resetsAtMs,
      now: input.now,
      random: input.random,
    }),
    reason: "Rate limited",
  };
}
