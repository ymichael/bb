export function legacyMarketplaceCategory(tags: readonly string[]): string {
  const first = tags[0];
  return first === undefined
    ? "Other"
    : first
        .split("-")
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}
