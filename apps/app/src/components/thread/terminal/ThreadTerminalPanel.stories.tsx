import type { ReactNode } from "react";
import type { TerminalSession } from "@bb/server-contract";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ThreadTerminalContent } from "./ThreadTerminalContent";
import type { ThreadTerminalController } from "./useThreadTerminalController";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";

export default {
  title: "terminal/Content",
};

const THREAD_ID = "thr_terminal_story";

const BASE_TERMINAL_SESSION: TerminalSession = makeTerminalSession({
  id: "term_story_1",
  threadId: THREAD_ID,
  environmentId: "env_terminal_story",
  hostId: "host_terminal_story",
  title: "Terminal 1",
  initialCwd: "/Users/michael/project",
  createdAt: 1,
  updatedAt: 1,
});

const RUNNING_SESSION: TerminalSession = {
  ...BASE_TERMINAL_SESSION,
  status: "running",
};

const DISCONNECTED_SESSION: TerminalSession = {
  ...BASE_TERMINAL_SESSION,
  status: "disconnected",
  updatedAt: 2,
};

const STARTING_SESSION: TerminalSession = {
  ...BASE_TERMINAL_SESSION,
  status: "starting",
  updatedAt: 2,
};

const EXITED_SESSION: TerminalSession = {
  ...BASE_TERMINAL_SESSION,
  status: "exited",
  exitCode: 0,
  closeReason: "user",
  updatedAt: 2,
};

interface MakeControllerArgs {
  activeSession: TerminalSession | null;
  canCreateTerminal: boolean;
  hasTerminalQueryError: boolean;
  isCreateTerminalPending: boolean;
  isPanelOpen: boolean;
  shouldRetainActiveTerminalView?: boolean;
  terminalBodyMessage: string;
}

interface TerminalContentStageProps {
  children?: ReactNode;
  controller: ThreadTerminalController;
}

function noopAction(): void {}

function noopTerminalIdAction(_terminalId: string): void {}

function noopSessionChange(_session: TerminalSession): void {}

function noopTitleChange(_title: string): void {}

function makeController({
  activeSession,
  canCreateTerminal,
  hasTerminalQueryError,
  isCreateTerminalPending,
  isPanelOpen,
  shouldRetainActiveTerminalView = false,
  terminalBodyMessage,
}: MakeControllerArgs): ThreadTerminalController {
  return {
    activeSession,
    canCreateTerminal,
    handleActiveTerminalSessionChange: noopSessionChange,
    handleActiveTerminalTitleChange: noopTitleChange,
    handleActiveTerminalUserInput: noopAction,
    handleCreateTerminal: noopAction,
    handleSelectTerminal: noopTerminalIdAction,
    hasTerminalQueryError,
    isCreateTerminalPending,
    isPanelOpen,
    shouldMountTerminalView: isPanelOpen,
    shouldRetainActiveTerminalView,
    terminalBodyMessage,
  };
}

function terminalController(
  activeSession: TerminalSession,
): ThreadTerminalController {
  return makeController({
    activeSession,
    canCreateTerminal: true,
    hasTerminalQueryError: false,
    isCreateTerminalPending: false,
    isPanelOpen: true,
    terminalBodyMessage: "No terminals",
  });
}

const disconnectedController = terminalController(DISCONNECTED_SESSION);

const disconnectedUnavailableController = makeController({
  activeSession: DISCONNECTED_SESSION,
  canCreateTerminal: false,
  hasTerminalQueryError: false,
  isCreateTerminalPending: false,
  isPanelOpen: true,
  terminalBodyMessage: "No terminals",
});

const startingController = terminalController(STARTING_SESSION);
const exitedController = terminalController(EXITED_SESSION);

const emptyController = makeController({
  activeSession: null,
  canCreateTerminal: true,
  hasTerminalQueryError: false,
  isCreateTerminalPending: false,
  isPanelOpen: true,
  terminalBodyMessage: "No terminals",
});

const startingEmptyController = makeController({
  activeSession: null,
  canCreateTerminal: true,
  hasTerminalQueryError: false,
  isCreateTerminalPending: true,
  isPanelOpen: true,
  terminalBodyMessage: "Starting terminal...",
});

const loadingController = makeController({
  activeSession: null,
  canCreateTerminal: true,
  hasTerminalQueryError: false,
  isCreateTerminalPending: false,
  isPanelOpen: true,
  terminalBodyMessage: "Starting terminal...",
});

const queryErrorController = makeController({
  activeSession: null,
  canCreateTerminal: true,
  hasTerminalQueryError: true,
  isCreateTerminalPending: false,
  isPanelOpen: true,
  terminalBodyMessage: "No terminals",
});

function TerminalContentStage({
  children,
  controller,
}: TerminalContentStageProps) {
  return (
    <div className="h-[260px] w-full max-w-[720px] min-w-0 overflow-hidden rounded-md border border-border bg-background">
      <section
        aria-label="Thread terminal"
        className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      >
        {children ?? <ThreadTerminalContent controller={controller} />}
      </section>
    </div>
  );
}

function RunningTerminalPreview() {
  return (
    <div className="flex h-full flex-col justify-end bg-background p-3 font-mono text-xs leading-5 text-foreground">
      <div>$ pnpm test --filter @bb/app</div>
      <div style={{ color: "var(--ansi-10)" }}>8 tests passed</div>
      <div className="text-muted-foreground">$</div>
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard labelWidth="190px">
      <StoryRow label="disconnected" hint="Replacement available.">
        <TerminalContentStage controller={disconnectedController} />
      </StoryRow>
      <StoryRow
        label="disconnected, unavailable"
        hint="No replacement available."
      >
        <TerminalContentStage controller={disconnectedUnavailableController} />
      </StoryRow>
      <StoryRow label="starting" hint="Session exists but is not running yet.">
        <TerminalContentStage controller={startingController} />
      </StoryRow>
      <StoryRow
        label="exited"
        hint="Terminal has ended and cannot accept input."
      >
        <TerminalContentStage controller={exitedController} />
      </StoryRow>
      <StoryRow label="empty" hint="Right panel tab with no visible sessions.">
        <TerminalContentStage controller={emptyController} />
      </StoryRow>
      <StoryRow label="starting empty" hint="Create mutation is in flight.">
        <TerminalContentStage controller={startingEmptyController} />
      </StoryRow>
      <StoryRow label="loading" hint="Initial terminal list query is loading.">
        <TerminalContentStage controller={loadingController} />
      </StoryRow>
      <StoryRow label="query error" hint="Terminal list query failed.">
        <TerminalContentStage controller={queryErrorController} />
      </StoryRow>
      <StoryRow label="running" hint="Running terminal content.">
        <TerminalContentStage controller={terminalController(RUNNING_SESSION)}>
          <RunningTerminalPreview />
        </TerminalContentStage>
      </StoryRow>
    </StoryCard>
  );
}
