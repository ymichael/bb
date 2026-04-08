import { z } from "zod";

/** Closed set of well-known error codes emitted by server-side domain logic.
 *  The base public ApiError envelope keeps `code` open as a string so routes
 *  can return additional route-specific values without widening this enum. */
export const domainErrorCodeSchema = z.enum([
  "invalid_request",
  "awaiting_user_interaction",
  "thread_not_found",
  "project_not_found",
  "thread_archived",
  "inactive_session",
  "provider_unavailable",
  "provider_timeout",
  "provider_rpc_error",
  "unsupported_operation",
  "no_active_turn",
  "internal_error",
]);
export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;

/** Base public error envelope shared by server routes. Route-specific schemas
 *  may extend this with typed fields such as structured `details` while
 *  preserving the common top-level `code` / `message` / `retryable` shape. */
export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
