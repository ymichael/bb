import type { ThreadEvent } from "@bb/domain";
import type { AgentRuntimeProviderSession } from "./types.js";

export interface RuntimeProviderIdentityState {
  pendingIdentityThreadIds: string[];
  providerId: string;
  threadIds: Set<string>;
}

interface CreateRuntimeProviderIdentityStateArgs {
  providerId: string;
}

interface RegisterThreadProviderArgs {
  providerId: string;
  providerState: RuntimeProviderIdentityState;
  expectsIdentityNotification: boolean;
  threadId: string;
}

interface RecordProviderThreadIdentityArgs {
  providerState: RuntimeProviderIdentityState;
  providerThreadId: string;
  threadId: string;
}

interface ResolveBbThreadIdForProviderThreadArgs {
  providerState: RuntimeProviderIdentityState;
  providerThreadId: string | undefined;
}

interface ForgetThreadArgs {
  providerState: RuntimeProviderIdentityState;
  threadId: string;
}

interface ResolveProviderEventThreadIdArgs {
  eventThreadId: string | undefined;
  providerState: RuntimeProviderIdentityState;
  sourceThreadId: string | undefined;
}

interface StampThreadEventScopeArgs {
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
      pendingIdentityThreadIds: [],
      providerId: args.providerId,
      threadIds: new Set(),
    };
  }

  registerThreadProvider(args: RegisterThreadProviderArgs): void {
    this.threadToProvider.set(args.threadId, args.providerId);
    args.providerState.threadIds.add(args.threadId);
    if (args.expectsIdentityNotification) {
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

  getProviderSession(threadId: string): AgentRuntimeProviderSession | null {
    const providerId = this.threadToProvider.get(threadId);
    const providerThreadId = this.threadToProviderThread.get(threadId);
    if (!providerId || !providerThreadId) {
      return null;
    }
    return { providerId, providerThreadId };
  }

  recordProviderThreadIdentity(args: RecordProviderThreadIdentityArgs): void {
    this.threadToProviderThread.set(args.threadId, args.providerThreadId);
  }

  resolveBbThreadIdForProviderThread(
    args: ResolveBbThreadIdForProviderThreadArgs,
  ): string | undefined {
    if (!args.providerThreadId) {
      return undefined;
    }

    for (const [bbThreadId, mappedProviderThreadId] of this
      .threadToProviderThread) {
      if (
        mappedProviderThreadId === args.providerThreadId &&
        args.providerState.threadIds.has(bbThreadId)
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
      args.sourceThreadId &&
      args.providerState.threadIds.has(args.sourceThreadId)
    ) {
      return args.sourceThreadId;
    }

    if (
      args.eventThreadId &&
      args.providerState.threadIds.has(args.eventThreadId)
    ) {
      return args.eventThreadId;
    }

    const lookupId = args.sourceThreadId || args.eventThreadId;
    if (lookupId) {
      for (const [bbThreadId, providerThreadId] of this
        .threadToProviderThread) {
        if (
          providerThreadId === lookupId &&
          args.providerState.threadIds.has(bbThreadId)
        ) {
          return bbThreadId;
        }
      }
    }

    if (
      args.providerState.threadIds.size === 1 &&
      !this.namesForeignThread(args.providerState, args.eventThreadId) &&
      !this.namesForeignThread(args.providerState, args.sourceThreadId)
    ) {
      return [...args.providerState.threadIds][0];
    }

    return undefined;
  }

  private namesForeignThread(
    providerState: RuntimeProviderIdentityState,
    threadId: string | undefined,
  ): boolean {
    if (threadId === undefined) {
      return false;
    }
    return (
      this.threadToProvider.has(threadId) &&
      !providerState.threadIds.has(threadId)
    );
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

  forgetThread(args: ForgetThreadArgs): void {
    args.providerState.threadIds.delete(args.threadId);
    args.providerState.pendingIdentityThreadIds =
      args.providerState.pendingIdentityThreadIds.filter(
        (pendingThreadId) => pendingThreadId !== args.threadId,
      );
    this.clearThread(args.threadId);
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
