export interface ExponentialBackoffDelayArgs {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function calculateExponentialBackoffDelay(
  args: ExponentialBackoffDelayArgs,
): number {
  const exponent = Math.max(0, args.attempt - 1);
  return Math.min(args.baseDelayMs * 2 ** exponent, args.maxDelayMs);
}
