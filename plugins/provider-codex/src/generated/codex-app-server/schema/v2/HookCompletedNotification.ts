
import type { HookRunSummary } from "./HookRunSummary.js";

export type HookCompletedNotification = { threadId: string, turnId: string | null, run: HookRunSummary, };
