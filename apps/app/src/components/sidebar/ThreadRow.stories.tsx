import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createStore, Provider } from "jotai";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar.js";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { ThreadRow, type ThreadRowOptions } from "./ThreadRow";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import {
  NO_COLLAPSED_CHILD_ACTIVITY,
  type CollapsedChildActivity,
} from "@bb/client-core";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";

const childActivity = (
  overrides: Partial<CollapsedChildActivity> = {},
): CollapsedChildActivity => ({ ...NO_COLLAPSED_CHILD_ACTIVITY, ...overrides });

const UNREAD_DONE_SETTLED_DOT_MS = 650;
const UNREAD_DONE_WORKING_MS = 650;

export default {
  title: "sidebar/Threads",
};

function SidebarStage({ children }: { children: ReactNode }) {
  return (
    <ThreadActionsProvider>
      <div className="w-full max-w-[460px] min-w-0 rounded-md bg-sidebar p-2 text-sidebar-foreground">
        <SidebarMenu className="gap-2">
          <SidebarMenuItem>
            <div className="space-y-0.5">{children}</div>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
    </ThreadActionsProvider>
  );
}

const makeThread = (overrides: Partial<ThreadListEntry> = {}) =>
  makeThreadListEntry({ id: "thr_default", ...overrides });

const noop = () => {};

type StoryThreadRowProps = Omit<
  ComponentProps<typeof ThreadRow>,
  "hasComposerDraft"
> & {
  hasComposerDraft?: boolean;
};

function StoryThreadRow({
  hasComposerDraft = false,
  ...props
}: StoryThreadRowProps) {
  return <ThreadRow {...props} hasComposerDraft={hasComposerDraft} />;
}

function UnreadDoneThreadRowCycle() {
  const [isUnreadDone, setIsUnreadDone] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setIsUnreadDone((current) => !current),
      isUnreadDone ? UNREAD_DONE_SETTLED_DOT_MS : UNREAD_DONE_WORKING_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [isUnreadDone]);

  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={
        isUnreadDone
          ? makeThread({
              lastReadAt: 50,
              latestAttentionAt: 200,
            })
          : makeThread({
              status: "active",
              lastReadAt: 200,
              latestAttentionAt: 200,
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })
      }
      isActive={false}
      options={defaultOption}
    />
  );
}

function WorkflowActiveThreadRow() {
  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={makeThread({
        title: "Background workflow audit",
        titleFallback: "Background workflow audit",
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      })}
      isActive={false}
      options={defaultOption}
    />
  );
}

function BackgroundCommandActiveThreadRow() {
  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={makeThread({
        title: "Background pixel gate",
        titleFallback: "Background pixel gate",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      })}
      isActive={false}
      options={defaultOption}
    />
  );
}

function BackgroundAgentActiveThreadRow() {
  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={makeThread({
        title: "Background agent review",
        titleFallback: "Background agent review",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      })}
      isActive={false}
      options={defaultOption}
    />
  );
}

function PlanModeActiveThreadRow() {
  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={makeThread({
        title: "Plan mode investigation",
        titleFallback: "Plan mode investigation",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 1,
          activeGoalCount: 0,
        },
      })}
      isActive={false}
      options={defaultOption}
    />
  );
}

function GoalActiveThreadRow() {
  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={makeThread({
        title: "Goal-driven cleanup",
        titleFallback: "Goal-driven cleanup",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 1,
        },
      })}
      isActive={false}
      options={defaultOption}
    />
  );
}

function WorkflowAndRuntimeActiveThreadRow() {
  return (
    <StoryThreadRow
      projectId="proj_demo"
      crossProjectId={null}
      thread={makeThread({
        title: "Workflow and foreground turn",
        titleFallback: "Workflow and foreground turn",
        status: "active",
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      })}
      isActive={false}
      options={defaultOption}
    />
  );
}

const defaultOption: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isCompact: false,
};
const childOption: ThreadRowOptions = {
  kind: "default",
  depth: 2,
  isCompact: true,
};
const projectlessOption: ThreadRowOptions = {
  kind: "default",
  depth: 0,
  isCompact: false,
};
function parentOption(
  overrides: Partial<Extract<ThreadRowOptions, { kind: "parent" }>> = {},
): ThreadRowOptions {
  return {
    kind: "parent",
    depth: 1,
    isCompact: false,
    isCollapsed: false,
    childCount: 0,
    childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
    onToggleCollapsed: noop,
    ...overrides,
  };
}

const parentThread = makeThread({
  id: "thr_parent",
  title: "Codex Parent",
  titleFallback: "Codex Parent",
});

const childThread = makeThread({
  id: "thr_child",
  title: "UI And Stories Consolidation",
  titleFallback: "UI And Stories Consolidation",
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="idle" hint="quiet thread, title then trailing slot">
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread()}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="projectless"
        hint="no project (Threads section): a normal navigable row at depth 0"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId={PERSONAL_PROJECT_ID}
            crossProjectId={null}
            thread={makeThread({
              projectId: PERSONAL_PROJECT_ID,
              title: "Sketch launch checklist",
              titleFallback: "Sketch launch checklist",
            })}
            isActive={false}
            options={projectlessOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="projectless (active)"
        hint="the selected projectless thread still shows the active background"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId={PERSONAL_PROJECT_ID}
            crossProjectId={null}
            thread={makeThread({
              projectId: PERSONAL_PROJECT_ID,
              title: "Sketch launch checklist",
              titleFallback: "Sketch launch checklist",
            })}
            isActive
            options={projectlessOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active"
        hint="selected thread shows the lighter sidebar selection background"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread()}
            isActive
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="busy"
        hint="runtime is active - far-right reserved slot shows the Loading03 working spinner"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              status: "active",
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active workflow"
        hint="runtime is idle, background workflow is active - far-right reserved slot shows the animated workflow glyph"
      >
        <SidebarStage>
          <WorkflowActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active background agent"
        hint="background agent is active - far-right reserved slot shows the animated delegated-agent glyph"
      >
        <SidebarStage>
          <BackgroundAgentActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active background command"
        hint="background shell command is active - far-right reserved slot shows the animated terminal glyph"
      >
        <SidebarStage>
          <BackgroundCommandActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active plan mode"
        hint="plan-mode banner is active - far-right reserved slot shows the animated plan glyph"
      >
        <SidebarStage>
          <PlanModeActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active goal"
        hint="goal banner is active - far-right reserved slot shows the animated target glyph"
      >
        <SidebarStage>
          <GoalActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active workflow + runtime"
        hint="foreground runtime activity wins and shows the Loading03 working spinner"
      >
        <SidebarStage>
          <WorkflowAndRuntimeActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="pending interaction"
        hint="foreground runtime remains active, so the working spinner wins over pending input"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              status: "active",
              hasPendingInteraction: true,
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="unread done"
        hint="live completion transition: working spinner, then the settled done dot"
      >
        <SidebarStage>
          <UnreadDoneThreadRowCycle />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="unread error"
        hint="status=error and unread - far-right reserved slot shows the destructive failure icon"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              status: "error",
              lastReadAt: 50,
              latestAttentionAt: 200,
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="draft"
        hint="unsubmitted follow-up draft — pencil sits flush right in the reserved status slot"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title: "Draft follow-up on release checklist",
              titleFallback: "Draft follow-up on release checklist",
            })}
            hasComposerDraft
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active working + draft"
        hint="foreground runtime activity wins over the saved draft and shows the working spinner"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title: "Editing while the agent works",
              titleFallback: "Editing while the agent works",
              status: "active",
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })}
            hasComposerDraft
            isActive
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="inactive working + draft"
        hint="foreground runtime activity wins over the saved draft even when the row is not selected"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title: "Background thread with a saved draft",
              titleFallback: "Background thread with a saved draft",
              status: "active",
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })}
            hasComposerDraft
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="draft + unread"
        hint="the persistent draft pencil owns the trailing slot instead of the unread dot"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title: "Review API migration notes",
              titleFallback: "Review API migration notes",
              lastReadAt: 50,
              latestAttentionAt: 200,
            })}
            hasComposerDraft
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="long title"
        hint="single-line truncate; title attr carries the full string"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title:
                "Investigate slow tests on recurring CI failures after the timeline pagination v2 merge",
              titleFallback: "Investigate slow tests on recurring CI failures",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="long title + rich pills"
        hint="title truncates in reading order through mention pills; hover reveals row actions"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title:
                "Review this branch using @docs/CODE_REVIEW.md and @apps/app/src/components/sidebar/ThreadRow.tsx before merging",
              titleFallback:
                "Review this branch using @docs/CODE_REVIEW.md and @apps/app/src/components/sidebar/ThreadRow.tsx before merging",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="long title + draft"
        hint="title truncates before the right-aligned draft icon"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              title:
                "Write a careful follow-up about the intermittent sidebar grouping bug after the next deploy",
              titleFallback:
                "Write a careful follow-up about the intermittent sidebar grouping bug",
            })}
            hasComposerDraft
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="env: managed worktree"
        hint="leading worktree icon appears before the thread title"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              queuedWork: "none",
              environmentWorkspaceDisplayKind: "managed-worktree",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="env: unmanaged worktree">
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              queuedWork: "none",
              environmentWorkspaceDisplayKind: "unmanaged-worktree",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="env: unmanaged worktree">
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              queuedWork: "none",
              environmentWorkspaceDisplayKind: "unmanaged-worktree",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="parent, no children"
        hint="no disclosure chevron when there are no children"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={parentThread}
            isActive={false}
            options={parentOption({ childCount: 0 })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="parent, expanded with delegated child"
        hint="parent row above its delegated child — the disclosure chevron sits after the title and rotates open"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={parentThread}
            isActive={false}
            options={parentOption({
              isCollapsed: false,
              childCount: 4,
            })}
          />
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={childThread}
            isActive={false}
            options={childOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="parent with a child from another project"
        hint="a child that lives in a different project than its parent shows the folder-export marker after its title; hover it for the project name"
      >
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map([["proj_web", "web"]])}
          threadById={new Map()}
        >
          <SidebarStage>
            <StoryThreadRow
              projectId="proj_demo"
              crossProjectId={null}
              thread={parentThread}
              isActive={false}
              options={parentOption({
                isCollapsed: false,
                childCount: 1,
              })}
            />
            <StoryThreadRow
              projectId="proj_web"
              crossProjectId="proj_web"
              thread={makeThread({
                id: "thr_child_web",
                projectId: "proj_web",
                parentThreadId: parentThread.id,
                title: "Update web client for release",
                titleFallback: "Update web client for release",
              })}
              isActive={false}
              options={childOption}
            />
          </SidebarStage>
        </ThreadTitleMentionResourcesProvider>
      </StoryRow>
      <StoryRow
        label="parent, collapsed"
        hint="chevron points right (default) for a collapsed parent with child rows"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={parentThread}
            isActive={false}
            options={parentOption({
              isCollapsed: true,
              childCount: 4,
            })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="parent, collapsed — child working"
        hint="trailing slot shows the Loading03 working spinner when a hidden child is working"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={parentThread}
            isActive={false}
            options={parentOption({
              isCollapsed: true,
              childCount: 4,
              childActivity: childActivity({ working: true }),
            })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="parent, collapsed — child needs input"
        hint="trailing slot shows the grey question icon when a hidden child is blocked on the user"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={parentThread}
            isActive={false}
            options={parentOption({
              isCollapsed: true,
              childCount: 4,
              childActivity: childActivity({ pending: true }),
            })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="parent, collapsed — needs input + working"
        hint="input needed wins priority over working: the trailing slot shows the grey question icon, not the spinner"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={parentThread}
            isActive={false}
            options={parentOption({
              isCollapsed: true,
              childCount: 4,
              childActivity: childActivity({
                pending: true,
                working: true,
              }),
            })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="child, busy"
        hint="far-right reserved slot shows the Loading03 working spinner"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              ...childThread,
              status: "active",
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })}
            isActive={false}
            options={childOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="child, pending"
        hint="far-right reserved slot shows the grey question icon"
      >
        <SidebarStage>
          <StoryThreadRow
            projectId="proj_demo"
            crossProjectId={null}
            thread={makeThread({
              ...childThread,
              hasPendingInteraction: true,
            })}
            isActive={false}
            options={childOption}
          />
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}

export function ActiveWorkflow() {
  return (
    <StoryCard>
      <StoryRow
        label="active workflow"
        hint="workflow-only activity uses the working color and SVG shimmer"
      >
        <SidebarStage>
          <WorkflowActiveThreadRow />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active workflow + runtime"
        hint="foreground runtime activity wins and shows the Loading03 working spinner"
      >
        <SidebarStage>
          <WorkflowAndRuntimeActiveThreadRow />
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}

export function SplitViewStatus() {
  const [store] = useState(createStore);

  useEffect(() => {
    store.set(splitLayoutAtom, {
      focusedPaneId: "pane-working",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "pane-idle",
            content: {
              kind: "thread",
              projectId: "proj_demo",
              threadId: "thr_split_idle",
            },
          },
          {
            type: "pane",
            paneId: "pane-working",
            content: {
              kind: "thread",
              projectId: "proj_demo",
              threadId: "thr_split_working",
            },
          },
        ],
      },
    });
    return () => store.set(splitLayoutAtom, null);
  }, [store]);

  return (
    <Provider store={store}>
      <StoryCard>
        <StoryRow
          label="idle split"
          hint="pane mini-map occupies the trailing status slot"
        >
          <SidebarStage>
            <StoryThreadRow
              projectId="proj_demo"
              crossProjectId={null}
              thread={makeThread({
                id: "thr_split_idle",
                title: "Static split position",
                titleFallback: "Static split position",
              })}
              isActive={false}
              options={defaultOption}
            />
          </SidebarStage>
        </StoryRow>
        <StoryRow
          label="working split"
          hint="the same trailing pane mini-map shimmers while work is active"
        >
          <SidebarStage>
            <StoryThreadRow
              projectId="proj_demo"
              crossProjectId={null}
              thread={makeThread({
                id: "thr_split_working",
                title: "Working in split view",
                titleFallback: "Working in split view",
                status: "active",
                runtime: {
                  displayStatus: "active",
                  hostReconnectGraceExpiresAt: null,
                },
              })}
              isActive
              options={defaultOption}
            />
          </SidebarStage>
        </StoryRow>
      </StoryCard>
    </Provider>
  );
}
