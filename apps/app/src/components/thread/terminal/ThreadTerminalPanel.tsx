import { useCallback, useEffect, useMemo } from "react";
import type { TerminalSession } from "@bb/server-contract";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  useCloseThreadTerminal,
  useCreateThreadTerminal,
  useThreadTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import {
  useThreadTerminalPanelState,
  useUpdateThreadTerminalPanelState,
} from "@/lib/thread-terminal-panel";
import { cn } from "@/lib/utils";
import { ThreadTerminalView } from "./ThreadTerminalView";

const DEFAULT_TERMINAL_COLS = 100;
const DEFAULT_TERMINAL_ROWS = 30;

interface ThreadTerminalPanelProps {
  canCreateTerminal: boolean;
  threadId: string;
}

interface TerminalTabProps {
  isActive: boolean;
  isClosing: boolean;
  onClose: () => void;
  onSelect: () => void;
  session: TerminalSession;
}

function pickActiveTerminalId(
  sessions: readonly TerminalSession[],
  preferredTerminalId: string | null,
): string | null {
  if (
    preferredTerminalId &&
    sessions.some((session) => session.id === preferredTerminalId)
  ) {
    return preferredTerminalId;
  }
  return sessions.find((session) => session.status !== "exited")?.id ?? null;
}

function terminalStatusLabel(session: TerminalSession): string {
  switch (session.status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "disconnected":
      return "disconnected";
    case "exited":
      return "exited";
  }
}

export function ThreadTerminalPanel({
  canCreateTerminal,
  threadId,
}: ThreadTerminalPanelProps) {
  const panelState = useThreadTerminalPanelState(threadId);
  const updatePanelState = useUpdateThreadTerminalPanelState(threadId);
  const terminalsQuery = useThreadTerminals(threadId, {
    enabled: panelState.isOpen,
  });
  const createTerminal = useCreateThreadTerminal();
  const closeTerminal = useCloseThreadTerminal();
  const sessions = terminalsQuery.data?.sessions ?? [];
  const activeTerminalId = useMemo(
    () => pickActiveTerminalId(sessions, panelState.activeTerminalId),
    [panelState.activeTerminalId, sessions],
  );
  const activeSession =
    sessions.find((session) => session.id === activeTerminalId) ?? null;

  useEffect(() => {
    if (panelState.activeTerminalId === activeTerminalId) {
      return;
    }
    updatePanelState((current) => ({
      ...current,
      activeTerminalId,
    }));
  }, [activeTerminalId, panelState.activeTerminalId, updatePanelState]);

  const handleCreateTerminal = useCallback(() => {
    if (!canCreateTerminal || createTerminal.isPending) {
      return;
    }
    createTerminal.mutate(
      {
        threadId,
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
      {
        onSuccess: (session) => {
          updatePanelState((current) => ({
            ...current,
            activeTerminalId: session.id,
            isOpen: true,
          }));
        },
      },
    );
  }, [canCreateTerminal, createTerminal, threadId, updatePanelState]);

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      updatePanelState((current) => ({
        ...current,
        activeTerminalId: terminalId,
        isOpen: true,
      }));
    },
    [updatePanelState],
  );

  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      closeTerminal.mutate({ threadId, terminalId });
    },
    [closeTerminal, threadId],
  );

  return (
    <section
      aria-label="Thread terminals"
      className="flex h-full min-h-0 min-w-0 flex-col border-t border-border bg-background"
    >
      <div className="flex h-10 min-h-10 items-center gap-2 border-b border-border bg-background px-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Terminal sessions"
        >
          {terminalsQuery.isLoading ? (
            <>
              <Skeleton className="h-6 w-28 rounded-md" />
              <Skeleton className="h-6 w-24 rounded-md" />
            </>
          ) : sessions.length > 0 ? (
            sessions.map((session) => (
              <TerminalTab
                key={session.id}
                session={session}
                isActive={session.id === activeTerminalId}
                isClosing={
                  closeTerminal.isPending &&
                  closeTerminal.variables?.terminalId === session.id
                }
                onSelect={() => handleSelectTerminal(session.id)}
                onClose={() => handleCloseTerminal(session.id)}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No terminals</p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground"
          disabled={!canCreateTerminal || createTerminal.isPending}
          onClick={handleCreateTerminal}
          aria-label="New terminal"
          title="New terminal"
        >
          {createTerminal.isPending ? (
            <Icon name="Spinner" className="size-3.5 animate-spin" />
          ) : (
            <Icon name="Plus" className="size-3.5" />
          )}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-[#0b0d10]">
        {terminalsQuery.error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
            Failed to load terminals.
          </div>
        ) : activeSession && activeSession.status === "running" ? (
          <ThreadTerminalView session={activeSession} threadId={threadId} />
        ) : activeSession ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            Terminal {terminalStatusLabel(activeSession)}.
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canCreateTerminal || createTerminal.isPending}
              onClick={handleCreateTerminal}
            >
              {createTerminal.isPending ? "Starting..." : "Start terminal"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function TerminalTab({
  isActive,
  isClosing,
  onClose,
  onSelect,
  session,
}: TerminalTabProps) {
  const statusLabel = terminalStatusLabel(session);
  return (
    <div
      className={cn(
        "group/terminal-tab inline-flex h-7 shrink-0 items-center rounded-md text-xs transition-colors",
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        className="flex h-full min-w-0 items-center rounded-l-md pl-2 pr-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onSelect}
        aria-pressed={isActive}
        title={`${session.title} (${statusLabel})`}
      >
        <span className="max-w-[180px] truncate">{session.title}</span>
        {session.status === "running" ? null : (
          <span className="ml-1 shrink-0 text-muted-foreground/80">
            {statusLabel}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={isClosing || session.status === "exited"}
        aria-label={`Close ${session.title}`}
        title="Close terminal"
        className="mr-1 ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:bg-muted-foreground/15 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-30"
      >
        {isClosing ? (
          <Icon name="Spinner" className="size-3 animate-spin" />
        ) : (
          <Icon name="X" className="size-3" />
        )}
      </button>
    </div>
  );
}
