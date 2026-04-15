import type { PromptInput, ThreadEvent, ThreadEventItem } from "@bb/domain";
import { buildUserMessageAckItem } from "./adapter-utils.js";

export interface AcceptedUserMessageState {
  pendingAcceptedUserMessages: AcceptedUserMessage[];
  userMessageCounter: number;
}

export interface AcceptedUserMessage {
  item: Extract<ThreadEventItem, { type: "userMessage" }>;
}

export interface CreateAcceptedUserMessageArgs<
  TState extends AcceptedUserMessageState,
> {
  clientRequestSequence?: number;
  input: PromptInput[];
  itemIdPrefix: string;
  state: TState;
}

export interface BuildAcceptedUserMessageEventArgs<
  TState extends AcceptedUserMessageState,
> extends CreateAcceptedUserMessageArgs<TState> {
  providerThreadId: string;
  threadId: string;
  turnId: string;
}

export interface QueueAcceptedUserMessageArgs<
  TState extends AcceptedUserMessageState,
> extends CreateAcceptedUserMessageArgs<TState> {}

export interface DrainAcceptedUserMessagesArgs<
  TState extends AcceptedUserMessageState,
> {
  events: ThreadEvent[];
  providerThreadId: string;
  state: TState;
  threadId: string;
  turnId: string;
}

function createAcceptedUserMessage<TState extends AcceptedUserMessageState>(
  args: CreateAcceptedUserMessageArgs<TState>,
): AcceptedUserMessage | null {
  if (args.input.length === 0) {
    return null;
  }
  const nextCounter = args.state.userMessageCounter + 1;
  const item = buildUserMessageAckItem(
    args.input,
    `${args.itemIdPrefix}-${nextCounter}`,
    args.clientRequestSequence,
  );
  if (!item) {
    return null;
  }
  args.state.userMessageCounter = nextCounter;
  return { item };
}

export function buildAcceptedUserMessageEvent<
  TState extends AcceptedUserMessageState,
>(args: BuildAcceptedUserMessageEventArgs<TState>): ThreadEvent[] {
  const accepted = createAcceptedUserMessage(args);
  if (!accepted) {
    return [];
  }
  return [{
    type: "item/completed",
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnId: args.turnId,
    item: accepted.item,
  }];
}

export function queueAcceptedUserMessage<
  TState extends AcceptedUserMessageState,
>(args: QueueAcceptedUserMessageArgs<TState>): void {
  const accepted = createAcceptedUserMessage(args);
  if (!accepted) {
    return;
  }
  args.state.pendingAcceptedUserMessages.push(accepted);
}

export function drainAcceptedUserMessages<
  TState extends AcceptedUserMessageState,
>(args: DrainAcceptedUserMessagesArgs<TState>): void {
  while (args.state.pendingAcceptedUserMessages.length > 0) {
    const accepted = args.state.pendingAcceptedUserMessages.shift();
    if (!accepted) {
      return;
    }
    args.events.push({
      type: "item/completed",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      turnId: args.turnId,
      item: accepted.item,
    });
  }
}
