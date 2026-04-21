import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Info, LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { DetailCard, DetailRow } from "@bb/ui-core";
import type { ReplayRunSpeed } from "@bb/server-contract";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/button";
import {
  SplitButton,
  type SplitButtonAction,
} from "@/components/ui/split-button";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

const DEFAULT_REPLAY_SPEED: ReplayRunSpeed = 1;
const REPLAY_SPEEDS: readonly ReplayRunSpeed[] = [0.5, 1, 2, 5, 10];

function formatSpeed(speed: ReplayRunSpeed): string {
  return `${speed}×`;
}

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
    mutationFn: ({
      captureId,
      speed,
    }: {
      captureId: string;
      speed: ReplayRunSpeed;
    }) => api.startReplayRun(captureId, { speed }),
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
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p className="m-0">
            Replay previously captured conversations in a fresh thread. To
            record new captures, create threads with{" "}
            <code className="font-mono text-xs">
              BB_DEV_REPLAY_CAPTURE=true pnpm dev
            </code>
            .
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
                startReplay.variables?.captureId === capture.captureId;
              const startFailedForThis =
                startReplay.isError &&
                startReplay.variables?.captureId === capture.captureId;
              const noEvents = capture.eventCounts.rawProviderEvents === 0;
              const primaryAction: SplitButtonAction = {
                label: `Start replay at ${formatSpeed(DEFAULT_REPLAY_SPEED)}`,
                onSelect: () =>
                  startReplay.mutate({
                    captureId: capture.captureId,
                    speed: DEFAULT_REPLAY_SPEED,
                  }),
                content: (
                  <>
                    {isStarting ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : null}
                    Replay
                  </>
                ),
              };
              const secondaryActions: SplitButtonAction[] = REPLAY_SPEEDS.map(
                (speed) => ({
                  label: `Start replay at ${formatSpeed(speed)}`,
                  onSelect: () =>
                    startReplay.mutate({
                      captureId: capture.captureId,
                      speed,
                    }),
                  content: <span>{formatSpeed(speed)}</span>,
                }),
              );
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
                    <SplitButton
                      disabled={isStarting || noEvents}
                      primaryAction={primaryAction}
                      secondaryActions={secondaryActions}
                      triggerLabel="Choose replay speed"
                      mobileTitle="Replay speed"
                    />
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
                    <div className="space-y-2 pb-3 pt-2">
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
