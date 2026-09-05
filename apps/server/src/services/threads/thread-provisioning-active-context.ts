import type {
  ThreadProvisionContext,
  ThreadProvisionProviderAsk,
} from "./thread-provisioning-context.js";

const activeThreadProvisionContexts = new Map<string, ThreadProvisionContext>();

function disarmProviderAsk(context: ThreadProvisionContext | undefined): void {
  const ask = context?.state.providerAsk ?? null;
  if (ask === null || ask.nextAskTimer === null) {
    return;
  }
  clearTimeout(ask.nextAskTimer);
  ask.nextAskTimer = null;
}

export function rememberActiveThreadProvisionContext(entry: {
  context: ThreadProvisionContext;
  threadId: string;
}): void {
  const previous = activeThreadProvisionContexts.get(entry.threadId);
  if (previous !== undefined && previous !== entry.context) {
    disarmProviderAsk(previous);
  }
  activeThreadProvisionContexts.set(entry.threadId, entry.context);
}

export function forgetActiveThreadProvisionContext(threadId: string): void {
  disarmProviderAsk(activeThreadProvisionContexts.get(threadId));
  activeThreadProvisionContexts.delete(threadId);
}

export function forgetAllActiveThreadProvisionContexts(): void {
  for (const threadId of [...activeThreadProvisionContexts.keys()]) {
    forgetActiveThreadProvisionContext(threadId);
  }
}

export function getActiveThreadProvisionContext(
  threadId: string,
): ThreadProvisionContext | null {
  return activeThreadProvisionContexts.get(threadId) ?? null;
}

export function listActiveThreadProviderAsks(): {
  ask: ThreadProvisionProviderAsk;
  threadId: string;
}[] {
  const asks: { ask: ThreadProvisionProviderAsk; threadId: string }[] = [];
  for (const [threadId, context] of activeThreadProvisionContexts) {
    const ask = context.state.providerAsk;
    if (ask !== null) {
      asks.push({ ask, threadId });
    }
  }
  return asks;
}
