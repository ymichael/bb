import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ThreadListEntry } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import {
  BRANCH_NAMES,
  HOST_IDS,
  PROJECT_IDS,
  makeProject as makeSharedProject,
  makeThreadListEntry,
} from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar.js";
import { ProjectListShell } from "./ProjectList";
import {
  ProjectListProjects,
  type ProjectListRowModel,
} from "./ProjectListProjects";
import type { ProjectThreadListState } from "./ProjectRow";
import { compareStandardThreads } from "@bb/client-core";
import { ThreadRow, type ThreadRowOptions } from "./ThreadRow";

export default {
  title: "sidebar/Status Notifications",
};

const noop = () => {};

const ANIMATION_SETTLED_MS = 650;
const ANIMATION_WORKING_MS = 650;

const defaultThreadOption: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isCompact: false,
};

type RollupSignal = "working" | "unreadDone" | "needsUser" | "unreadError";

const ROLLUP_SIGNALS: readonly RollupSignal[] = [
  "working",
  "unreadDone",
  "needsUser",
  "unreadError",
];

const ROLLUP_SIGNAL_LABEL: Record<RollupSignal, string> = {
  working: "Working",
  unreadDone: "Unread success",
  needsUser: "Input needed",
  unreadError: "Failed",
};

const HIDDEN_ROLLUP_COMBOS: readonly (readonly RollupSignal[])[] =
  ROLLUP_SIGNALS.flatMap((_, index, signals) => {
    const comboCount = 1 << signals.length;
    if (index !== 0) return [];
    return Array.from({ length: comboCount - 1 }, (_, comboIndex) =>
      signals.filter(
        (__, signalIndex) => (comboIndex + 1) & (1 << signalIndex),
      ),
    );
  });

function makeProject(overrides: Partial<ProjectResponse> = {}) {
  return makeSharedProject({ id: PROJECT_IDS.bb, name: "bb", ...overrides });
}

function makeThread(
  id: string,
  title: string,
  overrides: Partial<ThreadListEntry> = {},
) {
  return makeThreadListEntry({
    id,
    title,
    titleFallback: title,
    ...overrides,
  });
}

function makeSignalThread(
  signal: RollupSignal,
  id: string,
  overrides: Partial<ThreadListEntry> = {},
) {
  const title = ROLLUP_SIGNAL_LABEL[signal];
  const common = {
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  } satisfies Partial<ThreadListEntry>;

  switch (signal) {
    case "working":
      return makeThread(id, title, {
        ...common,
        status: "active",
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      });
    case "needsUser":
      return makeThread(id, title, {
        ...common,
        status: "active",
        hasPendingInteraction: true,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      });
    case "unreadDone":
      return makeThread(id, title, {
        ...common,
        lastReadAt: 50,
        latestAttentionAt: 200,
      });
    case "unreadError":
      return makeThread(id, title, {
        ...common,
        status: "error",
        lastReadAt: 50,
        latestAttentionAt: 200,
      });
  }
}

function SidebarFrame({ children }: { children: ReactNode }) {
  return (
    <ProjectActionsProvider>
      <ThreadActionsProvider>
        <div className="w-full max-w-[460px] min-w-0 rounded-md bg-sidebar p-2 text-sidebar-foreground">
          {children}
        </div>
      </ThreadActionsProvider>
    </ProjectActionsProvider>
  );
}

function ThreadRowStage({ children }: { children: ReactNode }) {
  return (
    <SidebarFrame>
      <SidebarMenu className="gap-2">
        <SidebarMenuItem>
          <div className="space-y-0.5">{children}</div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFrame>
  );
}

interface StoryThreadRowProps {
  thread: ThreadListEntry;
  isActive?: boolean;
  hasComposerDraft?: boolean;
}

function StoryThreadRow({
  thread,
  isActive = false,
  hasComposerDraft = false,
}: StoryThreadRowProps) {
  return (
    <ThreadRow
      projectId={PROJECT_IDS.bb}
      thread={thread}
      crossProjectId={null}
      isActive={isActive}
      hasComposerDraft={hasComposerDraft}
      options={defaultThreadOption}
    />
  );
}

type ToggleStoryCollapsedId = (id: string) => void;

function toggleCollapsedId(
  current: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

interface StoryProjectRow {
  project?: ProjectResponse;
  threadListState: ProjectThreadListState;
  initiallyCollapsed?: boolean;
}

interface ProjectListStageProps {
  rows: StoryProjectRow[];
  initialCollapsedThreadIds?: ReadonlySet<string>;
  initialCollapsedEnvironmentIds?: ReadonlySet<string>;
}

function ProjectListStage({
  rows,
  initialCollapsedThreadIds,
  initialCollapsedEnvironmentIds,
}: ProjectListStageProps) {
  const rowModels: ProjectListRowModel[] = rows.map((row) => ({
    project: row.project ?? makeProject(),
    threadListState: row.threadListState,
    isActive: false,
    isLocalPathInvalid: false,
  }));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () =>
      new Set(
        rows.flatMap((row, index) =>
          row.initiallyCollapsed ? [rowModels[index].project.id] : [],
        ),
      ),
  );
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<Set<string>>(
    () => new Set(initialCollapsedThreadIds ?? []),
  );
  const [collapsedEnvironmentIds, setCollapsedEnvironmentIds] = useState<
    Set<string>
  >(() => new Set(initialCollapsedEnvironmentIds ?? []));
  const onToggleProjectCollapsed = useCallback<ToggleStoryCollapsedId>((id) => {
    setCollapsedProjectIds((current) => toggleCollapsedId(current, id));
  }, []);
  const onToggleThreadCollapsed = useCallback<ToggleStoryCollapsedId>((id) => {
    setCollapsedThreadIds((current) => toggleCollapsedId(current, id));
  }, []);
  const onToggleEnvironmentCollapsed = useCallback<ToggleStoryCollapsedId>(
    (id) =>
      setCollapsedEnvironmentIds((current) => toggleCollapsedId(current, id)),
    [],
  );

  return (
    <SidebarFrame>
      <ProjectListShell>
        <ProjectListProjects
          status="ready"
          rows={rowModels}
          progressiveDisclosureEnabled
          collapsedProjectIds={collapsedProjectIds}
          collapsedThreadIds={collapsedThreadIds}
          collapsedEnvironmentIds={collapsedEnvironmentIds}
          compareThreads={compareStandardThreads}
          onCreateProjectThread={noop}
          onToggleProjectCollapsed={onToggleProjectCollapsed}
          onToggleThreadCollapsed={onToggleThreadCollapsed}
          onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
        />
      </ProjectListShell>
    </SidebarFrame>
  );
}

const statusThreads = {
  idle: makeThread("thr_status_idle", "Audit permission failure reports"),
  working: makeSignalThread("working", "thr_status_working"),
  needsUser: makeSignalThread("needsUser", "thr_status_needs_user"),
  unreadDone: makeSignalThread("unreadDone", "thr_status_unread_done"),
  unreadError: makeSignalThread("unreadError", "thr_status_unread_error"),
  longDraft: makeSignalThread("unreadDone", "thr_status_long_draft", {
    title:
      "Write a careful follow-up about the intermittent sidebar grouping bug after the next deploy",
    titleFallback:
      "Write a careful follow-up about the intermittent sidebar grouping bug",
  }),
};

function comboKey(combo: readonly RollupSignal[]) {
  return combo.join("-");
}

function comboLabel(combo: readonly RollupSignal[]) {
  return combo.map((signal) => ROLLUP_SIGNAL_LABEL[signal]).join(" + ");
}

function makeWorktreeComboThreads(combo: readonly RollupSignal[]) {
  const key = comboKey(combo);
  const environmentId = `env_rollup_${key}`;
  const environmentFields = {
    environmentId,
    environmentHostId: HOST_IDS.local,
    environmentBranchName: `bb/status-${key}`,
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "managed-worktree",
  } satisfies Partial<ThreadListEntry>;

  return {
    environmentId,
    threads: [
      ...combo.map((signal, index) =>
        makeSignalThread(signal, `thr_rollup_${key}_${index}`, {
          ...environmentFields,
          createdAt: 200 - index,
        }),
      ),
      makeThread(`thr_rollup_${key}_idle`, "Read companion thread", {
        ...environmentFields,
        createdAt: 1,
      }),
    ],
  };
}

function WorktreeRollupPreview({ combo }: { combo: readonly RollupSignal[] }) {
  const { environmentId, threads } = makeWorktreeComboThreads(combo);
  return (
    <ProjectListStage
      rows={[
        {
          threadListState: { status: "ready", threads },
        },
      ]}
      initialCollapsedEnvironmentIds={new Set([environmentId])}
    />
  );
}

function makeParentRollupThreads(combo: readonly RollupSignal[]) {
  const key = comboKey(combo);
  const parent = makeThread(`thr_parent_${key}`, "Collapsed parent", {
    environmentHostId: HOST_IDS.local,
    environmentBranchName: BRANCH_NAMES.default,
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "managed-worktree",
  });

  return {
    parentId: parent.id,
    threads: [
      parent,
      ...combo.map((signal, index) =>
        makeSignalThread(signal, `thr_parent_${key}_${index}`, {
          parentThreadId: parent.id,
          createdAt: 200 - index,
        }),
      ),
    ],
  };
}

function ParentRollupPreview({ combo }: { combo: readonly RollupSignal[] }) {
  const { parentId, threads } = makeParentRollupThreads(combo);
  return (
    <ProjectListStage
      rows={[
        {
          threadListState: { status: "ready", threads },
        },
      ]}
      initialCollapsedThreadIds={new Set([parentId])}
    />
  );
}

function AnimatedUnreadDoneThreadRow() {
  const [isUnreadDone, setIsUnreadDone] = useState(false);
  const thread = isUnreadDone
    ? makeSignalThread("unreadDone", "thr_animation_success")
    : makeSignalThread("working", "thr_animation_success");

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => {
        setIsUnreadDone((current) => !current);
      },
      isUnreadDone ? ANIMATION_SETTLED_MS : ANIMATION_WORKING_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [isUnreadDone]);

  return (
    <ThreadRowStage>
      <StoryThreadRow thread={thread} />
    </ThreadRowStage>
  );
}

export function ProductionStates() {
  return (
    <StoryCard labelWidth="210px">
      <StoryRow
        label="leaf rows"
        hint="Real ThreadRow states: idle, working, input needed, unread success, failed. Existing unread success shows the settled dot."
      >
        <ThreadRowStage>
          <StoryThreadRow thread={statusThreads.idle} />
          <StoryThreadRow thread={statusThreads.working} />
          <StoryThreadRow thread={statusThreads.needsUser} />
          <StoryThreadRow thread={statusThreads.unreadDone} />
          <StoryThreadRow thread={statusThreads.unreadError} />
        </ThreadRowStage>
      </StoryRow>
      <StoryRow
        label="active + draft"
        hint="Checks that the trailing glyph stays stable with selection, draft icon, and long title truncation."
      >
        <ThreadRowStage>
          <StoryThreadRow
            thread={statusThreads.longDraft}
            isActive
            hasComposerDraft
          />
        </ThreadRowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function HiddenRollupCombinations() {
  return (
    <StoryCard labelWidth="190px">
      <StoryRow
        label="worktree rollups"
        hint="Each non-empty hidden-state combo rendered through the real collapsed worktree path."
      >
        <div className="grid w-full max-w-[900px] gap-2">
          {HIDDEN_ROLLUP_COMBOS.map((combo) => (
            <div
              key={comboKey(combo)}
              className="grid gap-2 rounded-md border border-border bg-background p-2 text-sm md:grid-cols-[minmax(180px,1fr)_minmax(320px,460px)]"
            >
              <div className="self-center text-muted-foreground">
                {comboLabel(combo)}
              </div>
              <WorktreeRollupPreview combo={combo} />
            </div>
          ))}
        </div>
      </StoryRow>
    </StoryCard>
  );
}

export function CollapsedParentRollups() {
  return (
    <StoryCard labelWidth="190px">
      <StoryRow
        label="parent priority"
        hint="Collapsed parent rows use the same production priority: failed, input needed, unread success, then working."
      >
        <div className="grid w-full max-w-[900px] gap-2 md:grid-cols-3">
          <ParentRollupPreview combo={["working"]} />
          <ParentRollupPreview combo={["working", "needsUser"]} />
          <ParentRollupPreview
            combo={["working", "needsUser", "unreadError"]}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

export function UnreadDoneAnimation() {
  return (
    <StoryCard labelWidth="210px">
      <StoryRow
        label="unread success -> done"
        hint="Loops through a live completion transition: working, then settled dot."
      >
        <AnimatedUnreadDoneThreadRow />
      </StoryRow>
    </StoryCard>
  );
}
