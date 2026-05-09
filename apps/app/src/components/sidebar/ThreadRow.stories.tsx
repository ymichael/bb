import type { ReactNode } from "react";
import type { ThreadListEntry } from "@bb/domain";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { ThreadRow, type ThreadRowOptions } from "./ThreadRow";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "sidebar/Threads",
};

// Caps at the production sidebar max (460px) but shrinks with the parent so
// truncation behavior is visible at any container width.
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

const defaultOption: ThreadRowOptions = { kind: "default" };
const managedChildOption: ThreadRowOptions = { kind: "managed-child" };
function managerOption(
  overrides: Partial<Extract<ThreadRowOptions, { kind: "manager" }>> = {},
): ThreadRowOptions {
  return {
    kind: "manager",
    isCollapsed: false,
    managedChildCount: 0,
    managedChildBusyCount: 0,
    onToggleCollapsed: noop,
    ...overrides,
  };
}

const managerThread = makeThread({
  id: "thr_manager",
  type: "manager",
  title: "Codex Manager",
  titleFallback: "Codex Manager",
});

const childThread = makeThread({
  id: "thr_child",
  title: "UI And Stories Consolidation",
  titleFallback: "UI And Stories Consolidation",
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="idle" hint="quiet thread, no badges">
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread()}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="active"
        hint="selected thread shows the sidebar-border background"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread()}
            isActive
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="busy"
        hint="runtime is active — leading slot shows the spinning CircleDashed"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
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
        label="pending interaction"
        hint="needs attention — leading slot shows the attention dot (overrides busy)"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
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
        hint="latestAttentionAt > lastReadAt and not busy — small primary dot"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread({
              lastReadAt: 50,
              latestAttentionAt: 200,
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="promoted"
        hint="thread on the promoted branch — pill at trailing edge"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread()}
            isActive={false}
            isPromoted
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="long title"
        hint="single-line truncate; title attr carries the full string"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
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
        label="env: managed worktree"
        hint="trailing icon hint for the workspace display kind"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread({
              environmentWorkspaceDisplayKind: "managed-worktree",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="env: unmanaged worktree">
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread({
              environmentWorkspaceDisplayKind: "unmanaged-worktree",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="env: sandbox">
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread({
              environmentWorkspaceDisplayKind: "sandbox",
            })}
            isActive={false}
            options={defaultOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="manager, no children"
        hint="manager pill, no chevron, no count badge"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={managerThread}
            isActive={false}
            options={managerOption({ managedChildCount: 0 })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="manager, expanded with child"
        hint="manager row above its child — chevron rotated, count badge on the trailing edge, child uses the compact row height"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={managerThread}
            isActive={false}
            options={managerOption({
              isCollapsed: false,
              managedChildCount: 4,
            })}
          />
          <ThreadRow
            projectId="proj_demo"
            thread={childThread}
            isActive={false}
            options={managedChildOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="manager, collapsed"
        hint="chevron points right (default)"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={managerThread}
            isActive={false}
            options={managerOption({
              isCollapsed: true,
              managedChildCount: 4,
            })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="manager, busy via children"
        hint="manager itself is idle but managedChildBusyCount > 0 — chevron shows spinner under hover"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={managerThread}
            isActive={false}
            options={managerOption({
              managedChildCount: 3,
              managedChildBusyCount: 1,
            })}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="managed child, busy"
        hint="leading slot shows the spinner"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread({
              ...childThread,
              status: "active",
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
            })}
            isActive={false}
            options={managedChildOption}
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="managed child, pending"
        hint="attention dot replaces the chevron-down marker"
      >
        <SidebarStage>
          <ThreadRow
            projectId="proj_demo"
            thread={makeThread({
              ...childThread,
              hasPendingInteraction: true,
            })}
            isActive={false}
            options={managedChildOption}
          />
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}
