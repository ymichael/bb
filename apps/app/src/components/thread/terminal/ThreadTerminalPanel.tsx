import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSession } from "@bb/server-contract";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { TabPill } from "@/components/ui/tab-pill";
import {
  useCloseThreadTerminal,
  useCreateThreadTerminal,
  useRenameThreadTerminal,
  useThreadTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import {
  useSetThreadTerminalPanelOpen,
  useThreadTerminalPanelState,
  useUpdateThreadTerminalPanelState,
} from "@/lib/thread-terminal-panel";
import { ThreadTerminalView } from "./ThreadTerminalView";

const DEFAULT_TERMINAL_COLS = 100;
const DEFAULT_TERMINAL_ROWS = 30;
const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];
const TERMINAL_TITLE_MAX_LENGTH = 200;
const TERMINAL_TITLE_PATH_SEGMENT_COUNT = 3;
const TERMINAL_TITLE_RENAME_DEBOUNCE_MS = 250;

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

interface NormalizeTerminalTitleArgs {
  title: string;
}

interface FormatTerminalPathTitleArgs {
  path: string;
}

interface IsPathLikeTerminalTitlePathArgs {
  path: string;
}

interface ParseShellPathTitleArgs {
  title: string;
}

interface ShellPathTitleParts {
  path: string;
}

interface TerminalTitleRenameRequest {
  terminalId: string;
  title: string;
}

type NormalizedTerminalTitle = string | null;
type TerminalTitleChangeHandler = (title: string) => void;
type TerminalTitleRenameTimeout = number;

function isVisibleTerminalSession(session: TerminalSession): boolean {
  return session.status !== "exited";
}

function normalizeTerminalTitle({
  title,
}: NormalizeTerminalTitleArgs): NormalizedTerminalTitle {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return null;
  }

  const pathTitle = parseShellPathTitle({ title: trimmedTitle });
  if (pathTitle !== null) {
    return formatTerminalPathTitle({
      path: pathTitle.path,
    }).slice(0, TERMINAL_TITLE_MAX_LENGTH);
  }

  return trimmedTitle.slice(0, TERMINAL_TITLE_MAX_LENGTH);
}

function parseShellPathTitle({
  title,
}: ParseShellPathTitleArgs): ShellPathTitleParts | null {
  const match = /^[^@\s:]+@[^:\s]+:(.+)$/u.exec(title);
  const path = match?.[1];
  if (!path || !isPathLikeTerminalTitlePath({ path })) {
    return null;
  }
  return { path };
}

function isPathLikeTerminalTitlePath({
  path,
}: IsPathLikeTerminalTitlePathArgs): boolean {
  return (
    path === "~" ||
    path === "." ||
    path.startsWith("~/") ||
    path.startsWith("/") ||
    path.startsWith("./")
  );
}

function formatTerminalPathTitle({
  path,
}: FormatTerminalPathTitleArgs): string {
  if (path === "/" || path === "~" || path === ".") {
    return path;
  }

  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= TERMINAL_TITLE_PATH_SEGMENT_COUNT) {
    return path;
  }

  return `.../${segments.slice(-TERMINAL_TITLE_PATH_SEGMENT_COUNT).join("/")}`;
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
  return sessions[0]?.id ?? null;
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
  const setPanelOpen = useSetThreadTerminalPanelOpen(threadId);
  const dirtyTerminalIdsRef = useRef<Set<string>>(new Set());
  const closingCleanTerminalIdsRef = useRef<Set<string>>(new Set());
  const wasPanelOpenRef = useRef(panelState.isOpen);
  const latestRequestedTitleRenameRef =
    useRef<TerminalTitleRenameRequest | null>(null);
  const pendingTitleRenameTimeoutRef =
    useRef<TerminalTitleRenameTimeout | null>(null);
  const [shouldAutoStartOnOpen, setShouldAutoStartOnOpen] = useState(false);
  const terminalsQuery = useThreadTerminals(threadId, {
    enabled: panelState.isOpen,
  });
  const createTerminal = useCreateThreadTerminal();
  const closeTerminal = useCloseThreadTerminal();
  const renameTerminal = useRenameThreadTerminal();
  const sessions = terminalsQuery.data?.sessions ?? EMPTY_TERMINAL_SESSIONS;
  const visibleSessions = useMemo(
    () => sessions.filter(isVisibleTerminalSession),
    [sessions],
  );
  const activeTerminalId = useMemo(
    () => pickActiveTerminalId(visibleSessions, panelState.activeTerminalId),
    [panelState.activeTerminalId, visibleSessions],
  );
  const activeSession =
    visibleSessions.find((session) => session.id === activeTerminalId) ?? null;

  useEffect(() => {
    if (panelState.activeTerminalId === activeTerminalId) {
      return;
    }
    updatePanelState((current) => ({
      ...current,
      activeTerminalId,
    }));
  }, [activeTerminalId, panelState.activeTerminalId, updatePanelState]);

  useEffect(() => {
    const wasPanelOpen = wasPanelOpenRef.current;
    wasPanelOpenRef.current = panelState.isOpen;

    if (!panelState.isOpen) {
      setShouldAutoStartOnOpen(false);
      return;
    }
    if (!wasPanelOpen) {
      setShouldAutoStartOnOpen(true);
    }
  }, [panelState.isOpen]);

  useEffect(() => {
    return () => {
      if (pendingTitleRenameTimeoutRef.current === null) {
        return;
      }
      window.clearTimeout(pendingTitleRenameTimeoutRef.current);
    };
  }, []);

  const startTerminal = useCallback(
    () => {
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
            }));
          },
        },
      );
    },
    [canCreateTerminal, createTerminal, threadId, updatePanelState],
  );

  useEffect(() => {
    if (!shouldAutoStartOnOpen) {
      return;
    }
    if (!panelState.isOpen || !canCreateTerminal || terminalsQuery.error) {
      setShouldAutoStartOnOpen(false);
      return;
    }
    if (createTerminal.isPending || terminalsQuery.isLoading) {
      return;
    }
    if (visibleSessions.length > 0) {
      setShouldAutoStartOnOpen(false);
      return;
    }
    setShouldAutoStartOnOpen(false);
    startTerminal();
  }, [
    canCreateTerminal,
    createTerminal.isPending,
    panelState.isOpen,
    shouldAutoStartOnOpen,
    startTerminal,
    terminalsQuery.error,
    terminalsQuery.isLoading,
    visibleSessions.length,
  ]);

  useEffect(() => {
    if (panelState.isOpen) {
      return;
    }
    for (const session of visibleSessions) {
      if (
        session.lastUserInputAt !== null ||
        dirtyTerminalIdsRef.current.has(session.id) ||
        closingCleanTerminalIdsRef.current.has(session.id)
      ) {
        continue;
      }
      closingCleanTerminalIdsRef.current.add(session.id);
      closeTerminal.mutate(
        { mode: "if-clean", threadId, terminalId: session.id },
        {
          onSettled: () => {
            closingCleanTerminalIdsRef.current.delete(session.id);
          },
        },
      );
    }
  }, [closeTerminal, panelState.isOpen, threadId, visibleSessions]);

  const handleCreateTerminal = useCallback(() => {
    startTerminal();
  }, [startTerminal]);

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
      closeTerminal.mutate(
        { mode: "force", threadId, terminalId },
        {
          onSuccess: () => {
            dirtyTerminalIdsRef.current.delete(terminalId);
            closingCleanTerminalIdsRef.current.delete(terminalId);
          },
        },
      );
    },
    [closeTerminal, threadId],
  );

  const handleActiveTerminalUserInput = useCallback(() => {
    if (!activeTerminalId) {
      return;
    }
    dirtyTerminalIdsRef.current.add(activeTerminalId);
  }, [activeTerminalId]);

  const handleActiveTerminalTitleChange: TerminalTitleChangeHandler =
    useCallback(
      (title) => {
        if (!activeSession || activeSession.status !== "running") {
          return;
        }
        const normalizedTitle = normalizeTerminalTitle({ title });
        if (!normalizedTitle || normalizedTitle === activeSession.title) {
          return;
        }

        const request: TerminalTitleRenameRequest = {
          terminalId: activeSession.id,
          title: normalizedTitle,
        };
        const latestRequest = latestRequestedTitleRenameRef.current;
        if (
          latestRequest !== null &&
          latestRequest.terminalId === request.terminalId &&
          latestRequest.title === request.title
        ) {
          return;
        }

        latestRequestedTitleRenameRef.current = request;
        if (pendingTitleRenameTimeoutRef.current !== null) {
          window.clearTimeout(pendingTitleRenameTimeoutRef.current);
        }
        pendingTitleRenameTimeoutRef.current = window.setTimeout(() => {
          pendingTitleRenameTimeoutRef.current = null;
          renameTerminal.mutate(
            {
              threadId,
              terminalId: request.terminalId,
              title: request.title,
            },
            {
              onSettled: () => {
                const currentRequest = latestRequestedTitleRenameRef.current;
                if (
                  currentRequest !== null &&
                  currentRequest.terminalId === request.terminalId &&
                  currentRequest.title === request.title
                ) {
                  latestRequestedTitleRenameRef.current = null;
                }
              },
            },
          );
        }, TERMINAL_TITLE_RENAME_DEBOUNCE_MS);
      },
      [activeSession, renameTerminal, threadId],
    );

  const terminalIsStarting =
    createTerminal.isPending ||
    (canCreateTerminal && panelState.isOpen && shouldAutoStartOnOpen);

  const emptyTerminalMessage = terminalIsStarting
    ? "Starting terminal..."
    : "No terminals";

  const inactiveTerminalBodyMessage = canCreateTerminal
    ? "Starting terminal..."
    : "Terminals unavailable.";

  const bodyMessage = terminalIsStarting
    ? inactiveTerminalBodyMessage
    : "No terminals";

  const tabSessions = visibleSessions;

  const showTerminalPlaceholders =
    terminalsQuery.isLoading || (tabSessions.length === 0 && terminalIsStarting);

  const terminalBody = activeSession ? (
    activeSession.status === "running" ? (
      <ThreadTerminalView
        onTitleChange={handleActiveTerminalTitleChange}
        onUserInput={handleActiveTerminalUserInput}
        session={activeSession}
        threadId={threadId}
      />
    ) : (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Terminal {terminalStatusLabel(activeSession)}.
      </div>
    )
  ) : (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {bodyMessage}
    </div>
  );

  return (
    <section
      aria-label="Thread terminals"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      <div className="flex h-10 min-h-10 items-center gap-2 bg-background px-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Terminal sessions"
        >
          {terminalsQuery.isLoading ? (
            <>
              <Skeleton className="h-6 w-28 shrink-0 rounded-md" />
              <Skeleton className="h-6 w-24 shrink-0 rounded-md" />
            </>
          ) : tabSessions.length > 0 ? (
            tabSessions.map((session) => (
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
          ) : showTerminalPlaceholders ? (
            <p className="shrink-0 text-xs text-muted-foreground">
              {emptyTerminalMessage}
            </p>
          ) : null}
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground"
          onClick={() => setPanelOpen(false)}
          aria-label="Close terminal panel"
          title="Close terminal panel"
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {terminalsQuery.error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
            Failed to load terminals.
          </div>
        ) : (
          terminalBody
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
    <TabPill
      label={session.title}
      secondaryLabel={session.status === "running" ? null : statusLabel}
      title={`${session.title} (${statusLabel})`}
      isActive={isActive}
      onSelect={onSelect}
      closeAction={{
        onClose,
        closeLabel: `Close ${session.title}`,
        closeTooltip: "Close terminal",
        isClosing,
      }}
    />
  );
}
