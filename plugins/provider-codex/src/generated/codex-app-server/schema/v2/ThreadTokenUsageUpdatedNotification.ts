
import type { ThreadTokenUsage } from "./ThreadTokenUsage.js";

export type ThreadTokenUsageUpdatedNotification = { threadId: string, turnId: string, tokenUsage: ThreadTokenUsage, };
