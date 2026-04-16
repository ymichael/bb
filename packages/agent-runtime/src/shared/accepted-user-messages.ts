import type { ThreadEvent } from "@bb/domain";

export interface AcceptedUserMessageState {
  pendingAcceptedUserMessages: AcceptedUserMessage[];
}

export interface AcceptedUserMessage {
  clientRequestSequence: number;
}

export interface CreateAcceptedUserMessageArgs {
  clientRequestSequence?: number;
}

export interface BuildAcceptedUserMessageEventArgs
  extends CreateAcceptedUserMessageArgs {
  providerThreadId: string;
  threadId: string;
  turnId: string;
}

export interface QueueAcceptedUserMessageArgs<
  TState extends AcceptedUserMessageState,
> extends CreateAcceptedUserMessageArgs {
  state: TState;
}

export interface DrainAcceptedUserMessagesArgs<
  TState extends AcceptedUserMessageState,
> {
  events: ThreadEvent[];
  providerThreadId: string;
  state: TState;
  threadId: string;
  turnId: string;
}

function createAcceptedUserMessage(
  args: CreateAcceptedUserMessageArgs,
): AcceptedUserMessage | null {
  if (args.clientRequestSequence === undefined) {
    return null;
  }
  return { clientRequestSequence: args.clientRequestSequence };
}

export function buildAcceptedUserMessageEvent(
  args: BuildAcceptedUserMessageEventArgs,
): ThreadEvent[] {
  const accepted = createAcceptedUserMessage(args);
  if (!accepted) {
    return [];
  }
  return [{
    type: "turn/input/accepted",
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnId: args.turnId,
    clientRequestSequence: accepted.clientRequestSequence,
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
      type: "turn/input/accepted",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      turnId: args.turnId,
      clientRequestSequence: accepted.clientRequestSequence,
    });
  }
}
