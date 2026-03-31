import { Link, useParams } from "react-router-dom";
import { PageShell } from "@/components/layout/PageShell";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import { useUnarchiveThread } from "@/hooks/mutations/thread-mutations";
import { useThreads } from "@/hooks/queries/thread-queries";
import { getThreadDisplayTitle } from "@/lib/thread-title";

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
        <p className="py-12 text-center text-sm text-muted-foreground">Project not found</p>
      </PageShell>
    );
  }

  const archivedThreads =
    threads
      ?.filter((thread) => thread.archivedAt != null && thread.parentThreadId == null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)) ?? [];

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading archived threads…</p>
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
                  className="min-w-0 flex-1 truncate"
                >
                  {getThreadDisplayTitle(thread)}
                </Link>
                <ArchiveTimestampAction
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
