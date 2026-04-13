import type { ThreadEvent } from "@bb/domain";

interface PendingIdentityWaiter {
  resolve: (providerThreadId: string | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface RuntimeProviderIdentityState {
  identityWaiters: Map<string, PendingIdentityWaiter>;
  pendingIdentityThreadIds: string[];
  providerId: string;
  threadIds: Set<string>;
}

export interface CreateRuntimeProviderIdentityStateArgs {
  providerId: string;
}

export interface RegisterThreadProviderArgs {
  providerId: string;
  providerState: RuntimeProviderIdentityState;
  shouldWaitForProviderIdentity: boolean;
  threadId: string;
}

export interface RecordProviderThreadIdentityArgs {
  providerState: RuntimeProviderIdentityState;
  providerThreadId: string;
  threadId: string;
}

export interface ResolveBbThreadIdForProviderThreadArgs {
  providerState: RuntimeProviderIdentityState;
  providerThreadId: string | undefined;
}

export interface WaitForProviderThreadIdentityArgs {
  providerState: RuntimeProviderIdentityState;
  threadId: string;
  timeoutMs: number;
}

export interface ResolveProviderEventThreadIdArgs {
  eventThreadId: string | undefined;
  providerState: RuntimeProviderIdentityState;
  sourceThreadId: string | undefined;
}

export interface StampThreadEventScopeArgs {
  event: ThreadEvent;
  providerThreadId: string | undefined;
  threadId: string;
}

export class RuntimeThreadIdentityRegistry {
  private readonly threadToProvider = new Map<string, string>();
  private readonly threadToProviderThread = new Map<string, string>();

  createProviderState(
    args: CreateRuntimeProviderIdentityStateArgs,
  ): RuntimeProviderIdentityState {
    return {
      identityWaiters: new Map(),
      pendingIdentityThreadIds: [],
      providerId: args.providerId,
      threadIds: new Set(),
    };
  }

  registerThreadProvider(args: RegisterThreadProviderArgs): void {
    this.threadToProvider.set(args.threadId, args.providerId);
    args.providerState.threadIds.add(args.threadId);
    if (args.shouldWaitForProviderIdentity) {
      args.providerState.pendingIdentityThreadIds.push(args.threadId);
    }
  }

  resolveProviderForThread(threadId: string): string {
    const providerId = this.threadToProvider.get(threadId);
    if (!providerId) {
      throw new Error(`No provider associated with thread "${threadId}"`);
    }
    return providerId;
  }

  getProviderThreadId(threadId: string): string | undefined {
    return this.threadToProviderThread.get(threadId);
  }

  recordProviderThreadIdentity(args: RecordProviderThreadIdentityArgs): void {
    this.threadToProviderThread.set(args.threadId, args.providerThreadId);
    const waiter = args.providerState.identityWaiters.get(args.threadId);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timeout);
    args.providerState.identityWaiters.delete(args.threadId);
    waiter.resolve(args.providerThreadId);
  }

  waitForProviderThreadIdentity(
    args: WaitForProviderThreadIdentityArgs,
  ): Promise<string | null> {
    const existing = this.threadToProviderThread.get(args.threadId);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        args.providerState.identityWaiters.delete(args.threadId);
        resolve(null);
      }, args.timeoutMs);
      args.providerState.identityWaiters.set(args.threadId, {
        resolve,
        timeout,
      });
    });
  }

  resolveBbThreadIdForProviderThread(
    args: ResolveBbThreadIdForProviderThreadArgs,
  ): string | undefined {
    if (!args.providerThreadId) {
      return undefined;
    }

    for (const [bbThreadId, mappedProviderThreadId] of this.threadToProviderThread) {
      if (
        mappedProviderThreadId === args.providerThreadId
        && args.providerState.threadIds.has(bbThreadId)
      ) {
        return bbThreadId;
      }
    }

    return undefined;
  }

  resolveProviderEventThreadId(
    args: ResolveProviderEventThreadIdArgs,
  ): string | undefined {
    if (
      args.sourceThreadId
      && args.providerState.threadIds.has(args.sourceThreadId)
    ) {
      return args.sourceThreadId;
    }

    if (
      args.eventThreadId
      && args.providerState.threadIds.has(args.eventThreadId)
    ) {
      return args.eventThreadId;
    }

    const lookupId = args.sourceThreadId || args.eventThreadId;
    if (lookupId) {
      for (const [bbThreadId, providerThreadId] of this.threadToProviderThread) {
        if (
          providerThreadId === lookupId
          && args.providerState.threadIds.has(bbThreadId)
        ) {
          return bbThreadId;
        }
      }
    }

    if (args.providerState.threadIds.size === 1) {
      return [...args.providerState.threadIds][0];
    }

    return undefined;
  }

  resolvePendingProviderThreadIdentity(
    providerState: RuntimeProviderIdentityState,
  ): string | undefined {
    return providerState.pendingIdentityThreadIds.shift();
  }

  clearThread(threadId: string): void {
    this.threadToProvider.delete(threadId);
    this.threadToProviderThread.delete(threadId);
  }

  clearProviderState(providerState: RuntimeProviderIdentityState): void {
    providerState.pendingIdentityThreadIds = [];
    for (const threadId of providerState.threadIds) {
      this.clearThread(threadId);
    }
    this.resolvePendingIdentityWaiters(providerState);
  }

  resolvePendingIdentityWaiters(
    providerState: RuntimeProviderIdentityState,
  ): void {
    for (const [threadId, waiter] of providerState.identityWaiters) {
      clearTimeout(waiter.timeout);
      providerState.identityWaiters.delete(threadId);
      waiter.resolve(null);
    }
  }
}

export function stampThreadEventScope(
  args: StampThreadEventScopeArgs,
): ThreadEvent {
  if ("providerThreadId" in args.event && args.providerThreadId) {
    return {
      ...args.event,
      providerThreadId: args.providerThreadId,
      threadId: args.threadId,
    };
  }

  return {
    ...args.event,
    threadId: args.threadId,
  };
}
