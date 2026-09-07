
import type { ThreadItem } from "./ThreadItem.js";

export type ItemStartedNotification = { item: ThreadItem, threadId: string, turnId: string,
startedAtMs: number, };
