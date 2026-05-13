export function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}
