import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ThreadListEntry } from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import { PageShell } from "@/components/ui/page-shell.js";
import { Pill } from "@/components/ui/pill.js";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import { useUnarchiveThread } from "@/hooks/mutations/thread-state-mutations";
import { useArchivedThreads } from "@/hooks/queries/thread-queries";
import type { ArchivedThreadsKindFilter } from "@/hooks/queries/query-keys";
import { getThreadDisplayTitle } from "@/lib/thread-title";

interface FilterOption {
  value: ArchivedThreadsKindFilter;
  label: string;
}

const FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "all", label: "All" },
  { value: "manager", label: "Managers" },
  { value: "managed", label: "Managed" },
  { value: "unmanaged", label: "Unmanaged" },
];

type ArchivedThreadPillLabel = "managed" | "manager";

function getArchivedThreadPillLabel(
  thread: ThreadListEntry,
): ArchivedThreadPillLabel | null {
  if (thread.type === "manager") return "manager";
  if (thread.parentThreadId !== null) return "managed";
  return null;
}

export function ProjectArchivedThreadsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const [kindFilter, setKindFilter] =
    useState<ArchivedThreadsKindFilter>("all");
  const archivedThreadsQuery = useArchivedThreads({
    projectId,
    kind: kindFilter,
  });
  const unarchiveThread = useUnarchiveThread();

  const archivedThreads = useMemo(() => {
    const pages = archivedThreadsQuery.data?.pages ?? [];
    // Hide threads optimistically updated to archivedAt: null while the
    // archived list refetches.
    return pages.flat().filter((thread) => thread.archivedAt != null);
  }, [archivedThreadsQuery.data]);

  if (!projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Project not found
        </p>
      </PageShell>
    );
  }

  const isInitialLoading = archivedThreadsQuery.isPending;
  const showEmptyState = !isInitialLoading && archivedThreads.length === 0;

  return (
    <PageShell contentClassName="pt-0">
      <div className="mx-auto w-full max-w-3xl">
        <div className="sticky top-0 z-10 -mx-4 bg-background px-4 pt-4 md:-mx-5 md:px-5 md:pt-5">
          <OverflowFade placement="below" tone="background" />
          <div
            className="inline-flex items-center gap-1 rounded-lg border border-border/70 p-0.5"
            role="tablist"
            aria-label="Filter archived threads"
          >
            {FILTER_OPTIONS.map((option) => {
              const isActive = kindFilter === option.value;
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={isActive}
                  aria-pressed={isActive}
                  className="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground sm:px-3"
                  onClick={() => setKindFilter(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 pt-3">
          {isInitialLoading ? (
            <p className="text-sm text-muted-foreground">
              Loading archived threads…
            </p>
          ) : showEmptyState ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              No archived threads yet.
            </p>
          ) : (
            <div className="space-y-1">
              {archivedThreads.map((thread) => {
                const pillLabel = getArchivedThreadPillLabel(thread);
                return (
                  <div
                    key={thread.id}
                    className="group flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-state-hover"
                  >
                    <Link
                      to={`/projects/${projectId}/threads/${thread.id}`}
                      className="min-w-0 flex-1"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">
                          {getThreadDisplayTitle(thread)}
                        </span>
                        {pillLabel ? (
                          <Pill variant="outline" className="shrink-0">
                            {pillLabel}
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
                      className="hover:bg-accent-foreground/15"
                    />
                  </div>
                );
              })}
            </div>
          )}

          {archivedThreadsQuery.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                archivedThreadsQuery.fetchNextPage();
              }}
              disabled={archivedThreadsQuery.isFetchingNextPage}
              className="h-9 w-full justify-center rounded-md px-3 text-sm font-normal text-muted-foreground"
            >
              {archivedThreadsQuery.isFetchingNextPage
                ? "Loading…"
                : "Load more"}
            </Button>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}
