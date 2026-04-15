import type { PromptInput } from "@bb/domain";
import type {
  BuildSyntheticUserMessageAckArgs,
  SyntheticUserMessageAckItem,
} from "./provider-adapter.js";

export type SyntheticUserMessageAckBuilder = (
  args: BuildSyntheticUserMessageAckArgs,
) => SyntheticUserMessageAckItem | null;

export interface SyntheticUserMessageAck {
  itemId: string;
  item: SyntheticUserMessageAckItem;
}

export interface CreateSyntheticUserMessageAckArgs {
  buildAck: SyntheticUserMessageAckBuilder | undefined;
  input: PromptInput[];
  threadId: string;
}

export type QueueSyntheticUserMessageAckArgs = CreateSyntheticUserMessageAckArgs;

export interface RemovePendingSyntheticUserMessageAckArgs {
  ack: SyntheticUserMessageAck;
  threadId: string;
}

export interface ShiftPendingSyntheticUserMessageAckArgs {
  threadId: string;
}

export interface SyntheticUserMessageAckStore {
  clearAll(): void;
  clearThread(threadId: string): void;
  create(args: CreateSyntheticUserMessageAckArgs): SyntheticUserMessageAck | null;
  queue(args: QueueSyntheticUserMessageAckArgs): SyntheticUserMessageAck | null;
  removePending(args: RemovePendingSyntheticUserMessageAckArgs): void;
  shiftPending(
    args: ShiftPendingSyntheticUserMessageAckArgs,
  ): SyntheticUserMessageAck | undefined;
}

export function createSyntheticUserMessageAckStore(): SyntheticUserMessageAckStore {
  const pendingByThreadId = new Map<string, SyntheticUserMessageAck[]>();
  const countersByThreadId = new Map<string, number>();

  function createNextItemId(threadId: string): string {
    const next = (countersByThreadId.get(threadId) ?? 0) + 1;
    return `runtime-user-${next}`;
  }

  function commitNextItemId(threadId: string): void {
    countersByThreadId.set(threadId, (countersByThreadId.get(threadId) ?? 0) + 1);
  }

  function create(
    args: CreateSyntheticUserMessageAckArgs,
  ): SyntheticUserMessageAck | null {
    if (!args.buildAck) {
      return null;
    }
    const itemId = createNextItemId(args.threadId);
    const item = args.buildAck({
      input: args.input,
      itemId,
    });
    if (!item) {
      return null;
    }
    commitNextItemId(args.threadId);
    return {
      item,
      itemId,
    };
  }

  function queue(
    args: QueueSyntheticUserMessageAckArgs,
  ): SyntheticUserMessageAck | null {
    const ack = create(args);
    if (!ack) {
      return null;
    }
    pendingByThreadId.set(args.threadId, [
      ...(pendingByThreadId.get(args.threadId) ?? []),
      ack,
    ]);
    return ack;
  }

  function removePending(
    args: RemovePendingSyntheticUserMessageAckArgs,
  ): void {
    const pending = pendingByThreadId.get(args.threadId);
    if (!pending) {
      return;
    }
    const next = pending.filter((ack) => ack !== args.ack);
    if (next.length === 0) {
      pendingByThreadId.delete(args.threadId);
      return;
    }
    pendingByThreadId.set(args.threadId, next);
  }

  function shiftPending(
    args: ShiftPendingSyntheticUserMessageAckArgs,
  ): SyntheticUserMessageAck | undefined {
    const pending = pendingByThreadId.get(args.threadId);
    if (!pending || pending.length === 0) {
      return undefined;
    }
    const [ack, ...remaining] = pending;
    if (remaining.length === 0) {
      pendingByThreadId.delete(args.threadId);
    } else {
      pendingByThreadId.set(args.threadId, remaining);
    }
    return ack;
  }

  function clearThread(threadId: string): void {
    pendingByThreadId.delete(threadId);
    countersByThreadId.delete(threadId);
  }

  function clearAll(): void {
    pendingByThreadId.clear();
    countersByThreadId.clear();
  }

  return {
    clearAll,
    clearThread,
    create,
    queue,
    removePending,
    shiftPending,
  };
}
