import type { Thread } from "@beanbag/agent-core"

export function getThreadDisplayTitle(thread: Pick<Thread, "id" | "title" | "titleFallback">): string {
  if (thread.title && thread.title.trim().length > 0) return thread.title
  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback
  }
  return `Thread ${thread.id.slice(0, 8)}`
}
