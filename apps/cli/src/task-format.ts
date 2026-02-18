export function formatTaskDescription(description?: string): string {
  const normalized = description?.trim();
  return normalized && normalized.length > 0 ? normalized : "(none)";
}
