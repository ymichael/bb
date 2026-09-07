
import type { ThreadItem } from "./ThreadItem.js";
import type { TurnError } from "./TurnError.js";
import type { TurnItemsView } from "./TurnItemsView.js";
import type { TurnStatus } from "./TurnStatus.js";

export type Turn = {
id: string,
items: Array<ThreadItem>,
itemsView: TurnItemsView, status: TurnStatus,
error: TurnError | null,
startedAt: number | null,
completedAt: number | null,
durationMs: number | null, };
