
import type { ThreadItem } from "./ThreadItem.js";

export type ItemCompletedNotification = { item: ThreadItem, threadId: string, turnId: string,
completedAtMs: number, };
