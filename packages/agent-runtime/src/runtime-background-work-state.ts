import type { ThreadEvent } from "@bb/domain";

export class RuntimeBackgroundWorkState {
  private readonly openTaskIdsByThreadId = new Map<string, Set<string>>();

  clear(): void {
    this.openTaskIdsByThreadId.clear();
  }

  clearThread(threadId: string): void {
    this.openTaskIdsByThreadId.delete(threadId);
  }

  hasOpenWork(): boolean {
    return this.openTaskIdsByThreadId.size > 0;
  }

  hasOpenThreadWork(threadId: string): boolean {
    return (this.openTaskIdsByThreadId.get(threadId)?.size ?? 0) > 0;
  }

  observe(event: ThreadEvent): void {
    if (event.type === "item/started" || event.type === "item/completed") {
      if (
        event.item.type === "backgroundTask" ||
        event.item.type === "delegation"
      ) {
        this.setTaskOpen({
          isOpen: event.item.status === "pending",
          taskId: event.item.id,
          threadId: event.threadId,
        });
      }
      return;
    }

    if (
      event.type === "item/backgroundTask/progress" ||
      event.type === "item/backgroundTask/completed" ||
      event.type === "item/delegation/progress" ||
      event.type === "item/delegation/completed"
    ) {
      this.setTaskOpen({
        isOpen: event.item.status === "pending",
        taskId: event.item.id,
        threadId: event.threadId,
      });
    }
  }

  private setTaskOpen(args: {
    isOpen: boolean;
    taskId: string;
    threadId: string;
  }): void {
    const openTaskIds = this.openTaskIdsByThreadId.get(args.threadId);
    if (!args.isOpen) {
      if (!openTaskIds) {
        return;
      }
      openTaskIds.delete(args.taskId);
      if (openTaskIds.size === 0) {
        this.openTaskIdsByThreadId.delete(args.threadId);
      }
      return;
    }

    if (openTaskIds) {
      openTaskIds.add(args.taskId);
      return;
    }
    this.openTaskIdsByThreadId.set(args.threadId, new Set([args.taskId]));
  }
}
