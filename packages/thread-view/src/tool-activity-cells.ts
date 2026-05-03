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
  toolActivity: {
    activeCell: ToolActivityCell | null;
    finalizedExecCallIds: Set<string>;
    historyCells: ToolActivityCell[];
  };
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
): {
  cell: ViewProviderExecutionMessage;
  call: ViewProviderExecutionMessage;
} | null {
  for (
    let index = state.toolActivity.historyCells.length - 1;
    index >= 0;
    index -= 1
  ) {
    const cell = state.toolActivity.historyCells[index];
    if (!cell || isWebActivityMessage(cell)) {
      continue;
    }

    const call = findExecMessageInActiveCell(cell, callId);
    if (!call) continue;

    return {
      cell,
      call,
    };
  }

  return null;
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
): void {
  if (message.status === "pending") {
    message.status = "interrupted";
  }
}

export function flushActiveToolCell(
  state: ToolActivityCellStateOwner,
): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;

  if (isProviderExecutionMessage(active) && active.status !== "pending") {
    state.toolActivity.finalizedExecCallIds.add(active.callId);
  }

  state.toolActivity.historyCells.push(active);
  state.messages.push(active);
  state.toolActivity.activeCell = null;
}
