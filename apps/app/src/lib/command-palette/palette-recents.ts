const PALETTE_RECENTS_KEY = "bb.palette.recents";
const PALETTE_RECENTS_LIMIT = 8;

export function readPaletteRecents(): string[] {
  try {
    const stored = window.localStorage.getItem(PALETTE_RECENTS_KEY);
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, PALETTE_RECENTS_LIMIT);
  } catch {
    return [];
  }
}

export function recordPaletteRecent(
  recents: readonly string[],
  actionId: string,
): string[] {
  const next = [
    actionId,
    ...recents.filter((entry) => entry !== actionId),
  ].slice(0, PALETTE_RECENTS_LIMIT);
  try {
    window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}
