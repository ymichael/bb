import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { threadConversationOutlines } from "../schema.js";

export interface ThreadConversationOutlineRecord {
  itemsJson: string;
  projectionKey: string;
}

export function getThreadConversationOutlineRecord(
  db: DbConnection,
  threadId: string,
): ThreadConversationOutlineRecord | null {
  return (
    db
      .select({
        itemsJson: threadConversationOutlines.itemsJson,
        projectionKey: threadConversationOutlines.projectionKey,
      })
      .from(threadConversationOutlines)
      .where(eq(threadConversationOutlines.threadId, threadId))
      .get() ?? null
  );
}

export function upsertThreadConversationOutlineRecord(
  db: DbConnection,
  args: ThreadConversationOutlineRecord & { threadId: string },
): void {
  db.insert(threadConversationOutlines)
    .values(args)
    .onConflictDoUpdate({
      target: threadConversationOutlines.threadId,
      set: {
        itemsJson: args.itemsJson,
        projectionKey: args.projectionKey,
      },
    })
    .run();
}
