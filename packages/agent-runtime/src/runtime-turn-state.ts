import type { ThreadEvent } from "@bb/domain";

export class RuntimeTurnState {
  private readonly activeTurnIdByThreadId = new Map<string, string>();

  clear(): void {
    this.activeTurnIdByThreadId.clear();
  }

  clearThread(threadId: string): void {
    this.activeTurnIdByThreadId.delete(threadId);
  }

  getActiveTurnId(threadId: string): string | undefined {
    return this.activeTurnIdByThreadId.get(threadId);
  }

  observe(event: ThreadEvent): void {
    if (event.type === "turn/started") {
      this.activeTurnIdByThreadId.set(event.threadId, event.turnId);
      return;
    }

    if (
      event.type === "turn/completed" &&
      this.activeTurnIdByThreadId.get(event.threadId) === event.turnId
    ) {
      this.activeTurnIdByThreadId.delete(event.threadId);
    }
  }
}
