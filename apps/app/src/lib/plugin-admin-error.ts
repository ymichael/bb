export function pluginAdminErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    const prefix = `HTTP ${error.status}: `;
    return error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
