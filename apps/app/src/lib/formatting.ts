export function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));

  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  const elapsedWeeks = Math.floor(elapsedDays / 7);
  return `${elapsedWeeks}w`;
}

export function formatSnakeCaseLabel(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
