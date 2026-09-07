import { LEGACY_CODEX_GOAL_EXTENSION_KIND } from "@bb/domain";
import type { ThreadEvent } from "@bb/domain";

interface PendingGoalClearWaiter {
  afterRevision: number;
  resolve: (confirmed: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WaitForGoalClearArgs {
  afterRevision: number;
  threadId: string;
  timeoutMs: number;
}

export class RuntimeThreadGoalState {
  private readonly clearRevisionByThreadId = new Map<string, number>();
  private readonly clearWaitersByThreadId = new Map<
    string,
    Set<PendingGoalClearWaiter>
  >();

  clear(): void {
    this.clearRevisionByThreadId.clear();
    for (const threadId of [...this.clearWaitersByThreadId.keys()]) {
      this.resolveWaiters(threadId, false);
    }
  }

  clearThread(threadId: string): void {
    this.clearRevisionByThreadId.delete(threadId);
    this.resolveWaiters(threadId, false);
  }

  getClearRevision(threadId: string): number {
    return this.clearRevisionByThreadId.get(threadId) ?? 0;
  }

  waitForGoalClear(args: WaitForGoalClearArgs): Promise<boolean> {
    if (this.getClearRevision(args.threadId) > args.afterRevision) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const waiters =
        this.clearWaitersByThreadId.get(args.threadId) ??
        new Set<PendingGoalClearWaiter>();
      this.clearWaitersByThreadId.set(args.threadId, waiters);
      const waiter: PendingGoalClearWaiter = {
        afterRevision: args.afterRevision,
        resolve,
        timeout: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.clearWaitersByThreadId.delete(args.threadId);
          }
          resolve(false);
        }, args.timeoutMs),
      };
      waiters.add(waiter);
    });
  }

  observe(event: ThreadEvent): void {
    if (
      event.type !== "thread/extensionState/updated" ||
      event.kind !== LEGACY_CODEX_GOAL_EXTENSION_KIND ||
      event.payload !== null
    ) {
      return;
    }

    const revision = this.getClearRevision(event.threadId) + 1;
    this.clearRevisionByThreadId.set(event.threadId, revision);
    const waiters = this.clearWaitersByThreadId.get(event.threadId);
    if (!waiters) {
      return;
    }

    this.clearWaitersByThreadId.delete(event.threadId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(revision > waiter.afterRevision);
    }
  }

  private resolveWaiters(threadId: string, confirmed: boolean): void {
    const waiters = this.clearWaitersByThreadId.get(threadId);
    if (!waiters) {
      return;
    }

    this.clearWaitersByThreadId.delete(threadId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(confirmed);
    }
  }
}
