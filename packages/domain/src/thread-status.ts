import { z } from "zod";

/**
 * `pending` is the pre-execution status: the thread row exists but no message
 * has ever cleared a dispatch attempt, so nothing has been provisioned and no
 * session exists. It leaves the moment a first attempt clears (→ `starting`,
 * which absorbs provisioning and session start exactly as it does today). The
 * remaining five are execution statuses; see `thread-lifecycle.ts` for the
 * transitions between them.
 */
export const threadStatusValues = [
  "pending",
  "idle",
  "starting",
  "active",
  "stopping",
  "error",
] as const;
export const threadStatusSchema = z.enum(threadStatusValues);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
