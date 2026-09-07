import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { isUnreadDoneThread } from "@bb/client-core";

export function badgeCountFromSidebar(
  bootstrap: Pick<SidebarBootstrapResponse, "projects" | "personalProject">,
): number {
  let count = 0;
  const projects = [...bootstrap.projects, bootstrap.personalProject];
  for (const project of projects) {
    for (const thread of project.threads) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (thread.parentThreadId !== null) continue;
      if (thread.hasPendingInteraction || isUnreadDoneThread(thread)) {
        count += 1;
      }
    }
  }
  return count;
}
