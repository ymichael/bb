/**
 * Shared parsing utilities for provider-adapters.
 *
 * Prefer Zod schemas for structured validation. Use these helpers only when
 * the caller genuinely needs a loose record (e.g. JSON-RPC line parsing where
 * the shape is unknown until a discriminator is read).
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
