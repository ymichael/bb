import type { Thread, ThreadType } from "@bb/core"

export function getThreadDisplayTitle(thread: Pick<Thread, "id" | "title" | "titleFallback">): string {
  if (thread.title && thread.title.trim().length > 0) return thread.title
  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback
  }
  return `Thread ${thread.id.slice(0, 8)}`
}

/**
 * Returns the user-facing noun for a thread based on its type.
 * Manager threads are called "manager"; standard threads are called "thread".
 */
export function threadTypeLabel(type: ThreadType): string {
  return type === "manager" ? "manager" : "thread"
}
