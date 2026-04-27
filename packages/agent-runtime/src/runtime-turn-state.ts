import type { ThreadEvent } from "@bb/domain";
import { requireThreadEventScopeTurnId } from "@bb/domain";

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
      this.activeTurnIdByThreadId.set(
        event.threadId,
        requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        }),
      );
      return;
    }

    if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      if (this.activeTurnIdByThreadId.get(event.threadId) === turnId) {
        this.activeTurnIdByThreadId.delete(event.threadId);
      }
    }
  }
}
