import { useState, type ReactNode } from "react";
import { createStore, Provider } from "jotai";
import { SidebarStickyStack } from "@/components/ui/sidebar.js";
import {
  NO_COLLAPSED_CHILD_ACTIVITY,
  type CollapsedChildActivity,
} from "@bb/client-core";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DropPreviewRow } from "./ProjectRow";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection";

export default {
  title: "sidebar/Section row",
};

const noop = () => {};

function activity(
  overrides: Partial<CollapsedChildActivity> = {},
): CollapsedChildActivity {
  return { ...NO_COLLAPSED_CHILD_ACTIVITY, ...overrides };
}

function SidebarStage({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[460px] min-w-0 rounded-md bg-sidebar p-2 text-sidebar-foreground">
      <SidebarStickyStack>
        <div className="space-y-0.5">{children}</div>
      </SidebarStickyStack>
    </div>
  );
}

function SectionRow({
  activity: sectionActivity = activity(),
  collapsedThreads,
  isCollapsed = false,
  isDropTargetActive = false,
  label,
}: {
  activity?: CollapsedChildActivity;
  collapsedThreads?: readonly { id: string; projectId: string }[];
  isCollapsed?: boolean;
  isDropTargetActive?: boolean;
  label: string;
}) {
  return (
    <TopLevelSidebarSection
      label={label}
      collapsedActivity={sectionActivity}
      collapsedThreads={collapsedThreads}
      collapseControl={{
        isCollapsed,
        onToggleCollapsed: noop,
      }}
      isDropTargetActive={isDropTargetActive}
    >
      {null}
    </TopLevelSidebarSection>
  );
}

function SplitViewSidebarStage({ children }: { children: ReactNode }) {
  const [store] = useState(() => {
    const splitStore = createStore();
    splitStore.set(splitLayoutAtom, {
      focusedPaneId: "pane-build",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "pane-build",
            content: {
              kind: "thread",
              projectId: "project-work",
              threadId: "thread-build",
            },
          },
          {
            type: "pane",
            paneId: "pane-compose",
            content: { kind: "new-thread" },
          },
        ],
      },
    });
    return splitStore;
  });

  return (
    <Provider store={store}>
      <SidebarStage>{children}</SidebarStage>
    </Provider>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="expanded" hint="section header, no rolled-up status">
        <SidebarStage>
          <SectionRow label="Work" activity={activity()} isCollapsed={false} />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="collapsed unread"
        hint="collapsed sections show activity"
      >
        <SidebarStage>
          <SectionRow
            label="Q3"
            activity={activity({ unread: true })}
            isCollapsed
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="collapsed working" hint="busy descendant rolls up">
        <SidebarStage>
          <SectionRow
            label="Build"
            activity={activity({ working: true })}
            isCollapsed
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="collapsed split view"
        hint="a hidden split thread replaces its activity glyph with the pane mini-map"
      >
        <SplitViewSidebarStage>
          <SectionRow
            label="Build"
            activity={activity({ working: true })}
            collapsedThreads={[
              { id: "thread-build", projectId: "project-work" },
            ]}
            isCollapsed
          />
        </SplitViewSidebarStage>
      </StoryRow>
      <StoryRow
        label="collapsed plan mode"
        hint="hidden plan-mode banner rolls up to the right-aligned plan glyph"
      >
        <SidebarStage>
          <SectionRow
            label="Planning"
            activity={activity({ working: true, planMode: true })}
            isCollapsed
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="collapsed goal"
        hint="hidden active-goal banner rolls up to the right-aligned target glyph"
      >
        <SidebarStage>
          <SectionRow
            label="Goals"
            activity={activity({ working: true, goal: true })}
            isCollapsed
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="pending" hint="pending descendant wins the rollup">
        <SidebarStage>
          <SectionRow
            label="Reviews"
            activity={activity({ pending: true, unread: true })}
            isCollapsed
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow label="long name" hint="header truncates inside sidebar width">
        <SidebarStage>
          <SectionRow
            label="Very long customer migration and rollout section"
            activity={activity()}
            isCollapsed={false}
          />
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}

export function DragInto() {
  return (
    <StoryCard>
      <StoryRow
        label="drop target"
        hint="section highlights while a thread is dragged over it"
      >
        <SidebarStage>
          <SectionRow
            label="Work"
            activity={activity()}
            isCollapsed={false}
            isDropTargetActive
          />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="empty placeholder"
        hint="after the hover dwell, an empty slot opens inside the section"
      >
        <SidebarStage>
          <SectionRow
            label="Work"
            activity={activity()}
            isCollapsed={false}
            isDropTargetActive
          />
          <DropPreviewRow depth={0} />
        </SidebarStage>
      </StoryRow>
      <StoryRow
        label="loose-list drop"
        hint="dragging a thread out of a section previews the same slot at root depth in Threads"
      >
        <SidebarStage>
          <DropPreviewRow depth={0} />
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}
