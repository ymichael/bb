import type {
  EventProjectionCommandMessage,
  EventProjectionDelegationMessage,
  EventProjectionMessage,
  EventProjectionToolCallMessage,
  EventProjectionWebFetchMessage,
  EventProjectionWebSearchMessage,
} from "./event-projection-types.js";

export type ViewProviderExecutionMessage =
  | EventProjectionCommandMessage
  | EventProjectionToolCallMessage
  | EventProjectionDelegationMessage;
export type ViewWebActivityMessage =
  | EventProjectionWebSearchMessage
  | EventProjectionWebFetchMessage;
export type ToolActivityCell =
  | ViewProviderExecutionMessage
  | ViewWebActivityMessage;
export type WebActivityKind = ViewWebActivityMessage["kind"];

interface ToolActivityCellStateOwner {
  messages: EventProjectionMessage[];
  toolActivity: ToolActivityCellState;
}

interface ToolActivityCellState {
  activeCell: ToolActivityCell | null;
  execHistoryCellIndexByCallId: Map<string, number>;
  finalizedExecCallIds: Set<string>;
  historyCells: ToolActivityCell[];
}

type MaybeToolActivityCell =
  | EventProjectionMessage
  | ToolActivityCell
  | null
  | undefined;

interface FindWebActivityInHistoryCellsArgs {
  callId: string;
  itemKind?: WebActivityKind;
}

interface FindExecMessageInHistoryCellsResult {
  cell: ViewProviderExecutionMessage;
  call: ViewProviderExecutionMessage;
}

export function isProviderExecutionMessage(
  message: MaybeToolActivityCell,
): message is ViewProviderExecutionMessage {
  return (
    message?.kind === "command" ||
    message?.kind === "tool-call" ||
    message?.kind === "delegation"
  );
}

export function isWebActivityMessage(
  cell: MaybeToolActivityCell,
): cell is ViewWebActivityMessage {
  return cell?.kind === "web-search" || cell?.kind === "web-fetch";
}

export function findExecMessageInActiveCell(
  activeCell: ToolActivityCell | null,
  callId: string,
): ViewProviderExecutionMessage | null {
  if (!activeCell) return null;
  if (isProviderExecutionMessage(activeCell) && activeCell.callId === callId) {
    return activeCell;
  }
  return null;
}

export function findExecMessageInHistoryCells(
  state: ToolActivityCellStateOwner,
  callId: string,
): FindExecMessageInHistoryCellsResult | null {
  const historyIndex =
    state.toolActivity.execHistoryCellIndexByCallId.get(callId);
  if (historyIndex === undefined) return null;

  const cell = state.toolActivity.historyCells[historyIndex];
  if (!isProviderExecutionMessage(cell)) return null;

  const call = findExecMessageInActiveCell(cell, callId);
  if (!call) return null;

  return {
    cell,
    call,
  };
}

export function findWebActivityInHistoryCells(
  state: ToolActivityCellStateOwner,
  args: FindWebActivityInHistoryCellsArgs,
): ViewWebActivityMessage | null {
  for (
    let index = state.toolActivity.historyCells.length - 1;
    index >= 0;
    index -= 1
  ) {
    const cell = state.toolActivity.historyCells[index];
    if (!isWebActivityMessage(cell)) continue;
    if (cell.callId !== args.callId) continue;
    if (args.itemKind && cell.kind !== args.itemKind) continue;
    return cell;
  }

  return null;
}

export function interruptWebActivityMessage(
  message: ViewWebActivityMessage,
  completedAt: number | null,
): void {
  if (message.status === "pending") {
    message.status = "interrupted";
    message.completedAt = completedAt;
  }
}

export function flushActiveToolCell(
  state: ToolActivityCellStateOwner,
): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;

  const historyIndex = state.toolActivity.historyCells.length;
  state.toolActivity.historyCells.push(active);

  if (isProviderExecutionMessage(active)) {
    state.toolActivity.execHistoryCellIndexByCallId.set(
      active.callId,
      historyIndex,
    );
    if (active.status !== "pending") {
      state.toolActivity.finalizedExecCallIds.add(active.callId);
    }
  }

  state.messages.push(active);
  state.toolActivity.activeCell = null;
}
