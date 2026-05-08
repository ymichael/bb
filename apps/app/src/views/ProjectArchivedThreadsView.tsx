import { Link, useParams } from "react-router-dom";
import type { ThreadListEntry } from "@bb/domain";
import { PageShell, Pill } from "@/components/ui";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import { useUnarchiveThread } from "@/hooks/mutations/thread-state-mutations";
import { useThreads } from "@/hooks/queries/thread-queries";
import { getThreadDisplayTitle } from "@/lib/thread-title";

function isManagedThread(thread: ThreadListEntry): boolean {
  return thread.parentThreadId !== null;
}

export function ProjectArchivedThreadsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: threads, isLoading } = useThreads({
    projectId,
    archived: true,
  });
  const unarchiveThread = useUnarchiveThread();

  if (!projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Project not found
        </p>
      </PageShell>
    );
  }

  const archivedThreads =
    threads
      // Keep optimistic unarchive updates hidden while the archived list refetches.
      ?.filter((thread) => thread.archivedAt != null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)) ?? [];

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading archived threads…
          </p>
        ) : archivedThreads.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No archived threads yet.
          </p>
        ) : (
          <div className="space-y-1">
            {archivedThreads.map((thread) => (
              <div
                key={thread.id}
                className="group flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-accent"
              >
                <Link
                  to={`/projects/${projectId}/threads/${thread.id}`}
                  className="min-w-0 flex-1"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">
                      {getThreadDisplayTitle(thread)}
                    </span>
                    {isManagedThread(thread) ? (
                      <Pill variant="secondary" className="shrink-0">
                        managed
                      </Pill>
                    ) : null}
                  </span>
                </Link>
                <ThreadUnarchiveButton
                  isPending={
                    unarchiveThread.isPending &&
                    unarchiveThread.variables?.id === thread.id
                  }
                  onUnarchive={() => {
                    unarchiveThread.mutate({ id: thread.id });
                  }}
                  threadType={thread.type}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
