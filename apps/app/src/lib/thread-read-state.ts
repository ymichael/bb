import type { Thread } from "@bb/domain"

export type ThreadReadState = Pick<Thread, "lastReadAt" | "latestAttentionAt">

export function isThreadRead(thread: ThreadReadState): boolean {
  return (thread.lastReadAt ?? 0) >= thread.latestAttentionAt
}
