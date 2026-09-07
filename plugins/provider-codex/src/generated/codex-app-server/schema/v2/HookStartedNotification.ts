
import type { HookRunSummary } from "./HookRunSummary.js";

export type HookStartedNotification = { threadId: string, turnId: string | null, run: HookRunSummary, };
