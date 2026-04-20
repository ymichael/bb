import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, LoaderCircle, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { DetailCard, DetailRow } from "@bb/ui-core";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

const DEFAULT_REPLAY_SPEED = 1;

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

const REPLAY_CAPTURES_QUERY_KEY = ["internal-replay-captures"] as const;

export function InternalReplayListView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleExpanded = (captureId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(captureId)) {
        next.delete(captureId);
      } else {
        next.add(captureId);
      }
      return next;
    });
  };

  const capturesQuery = useQuery({
    queryKey: REPLAY_CAPTURES_QUERY_KEY,
    queryFn: () => api.listReplayCaptures(),
  });
  const deleteCapture = useMutation({
    mutationFn: (captureId: string) => api.deleteReplayCapture(captureId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: REPLAY_CAPTURES_QUERY_KEY,
      });
    },
  });
  const startReplay = useMutation({
    mutationFn: (captureId: string) =>
      api.startReplayRun(captureId, { speed: DEFAULT_REPLAY_SPEED }),
    onSuccess: (result) => {
      navigate(
        `/projects/${result.projectId}/threads/${result.replayThreadId}`,
      );
    },
  });

  const captures = capturesQuery.data?.captures ?? [];

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            Replay captured threads
          </h1>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono text-xs">
              BB_DEV_REPLAY_CAPTURE=true pnpm dev
            </code>
          </p>
        </div>
        {capturesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : capturesQuery.isError ? (
          <p className="text-sm text-destructive">
            Failed to load replay captures.
          </p>
        ) : captures.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No replay captures found on any connected host.
          </p>
        ) : (
          <div className="space-y-1">
            {captures.map((capture) => {
              const title = capture.title ?? capture.captureId;
              const projectName = capture.projectName ?? capture.projectId;
              const isExpanded = expandedIds.has(capture.captureId);
              const isDeleting =
                deleteCapture.isPending &&
                deleteCapture.variables === capture.captureId;
              const isStarting =
                startReplay.isPending &&
                startReplay.variables === capture.captureId;
              const startFailedForThis =
                startReplay.isError &&
                startReplay.variables === capture.captureId;
              return (
                <div key={`${capture.hostId}:${capture.captureId}`}>
                  <div className="flex h-9 items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(capture.captureId)}
                      aria-expanded={isExpanded}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3 shrink-0 text-muted-foreground transition-transform",
                          isExpanded && "rotate-90",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {title}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {projectName} · {capture.providerId}
                        </span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Start replay"
                      title="Start replay"
                      disabled={
                        isStarting ||
                        capture.eventCounts.rawProviderEvents === 0
                      }
                      onClick={() => startReplay.mutate(capture.captureId)}
                      className="size-6"
                    >
                      {isStarting ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <Play className="size-3" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete replay capture"
                      title="Delete replay capture"
                      disabled={isDeleting}
                      onClick={() => deleteCapture.mutate(capture.captureId)}
                      className="size-6"
                    >
                      {isDeleting ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <Trash2 className="size-3" />
                      )}
                    </Button>
                  </div>
                  {isExpanded ? (
                    <div className="space-y-2 pb-3">
                      <DetailCard>
                        <DetailRow
                          label="Capture"
                          valueClassName="min-w-0 truncate font-mono"
                        >
                          {capture.captureId}
                        </DetailRow>
                        <DetailRow
                          label="Host"
                          valueClassName="min-w-0 truncate"
                        >
                          {capture.hostId}
                        </DetailRow>
                        <DetailRow
                          label="Provider"
                          valueClassName="min-w-0 truncate"
                        >
                          {capture.providerId}
                        </DetailRow>
                        <DetailRow
                          label="Project"
                          valueClassName="min-w-0 truncate"
                        >
                          {capture.projectName ?? capture.projectId}
                        </DetailRow>
                        <DetailRow
                          label="Thread"
                          valueClassName="min-w-0 truncate font-mono"
                        >
                          {capture.threadId}
                        </DetailRow>
                        <DetailRow
                          label="Captured"
                          valueClassName="min-w-0 truncate"
                        >
                          {formatDate(capture.capturedAt)}
                        </DetailRow>
                        <DetailRow
                          label="Raw events"
                          valueClassName="min-w-0 truncate"
                        >
                          {capture.eventCounts.rawProviderEvents}
                        </DetailRow>
                      </DetailCard>
                      {startFailedForThis ? (
                        <p className="text-xs text-destructive">
                          Failed to start replay.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageShell>
  );
}
