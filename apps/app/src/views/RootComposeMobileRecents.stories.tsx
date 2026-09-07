import type { ReactNode } from "react";
import type { ThreadListEntry } from "@bb/domain";
import { StoryCard, StoryRow } from "../../.ladle/story-card";
import {
  PROJECT_IDS,
  PROJECT_NAMES,
  STORY_PROVIDERS_BY_ID,
  makeThreadListEntry,
} from "../../.ladle/story-fixtures";
import { RootComposeMobileRecents } from "./RootComposeMobileRecents";

export default {
  title: "views/Mobile Recents",
};

interface MobileStageProps {
  children: ReactNode;
}

interface MakeRecentThreadArgs {
  overrides?: Partial<ThreadListEntry>;
}

function MobileStage({ children }: MobileStageProps) {
  return (
    <div className="root-compose-mobile-recents-story w-[390px] max-w-full bg-background p-4">
      <style>{`
        @media (min-width: 768px) {
          .root-compose-mobile-recents-story [data-root-compose-mobile-recents] {
            display: block;
          }
        }
      `}</style>
      {children}
    </div>
  );
}

function makeRecentThread({
  overrides = {},
}: MakeRecentThreadArgs = {}): ThreadListEntry {
  return makeThreadListEntry({
    projectId: PROJECT_IDS.bb,
    ...overrides,
  });
}

const recentThreads: ThreadListEntry[] = [
  makeRecentThread({
    overrides: {
      id: "thr_mobile_just_starting",
      providerId: "claude-code",
      title: "Trace mobile thread creation feedback",
      titleFallback: "Trace mobile thread creation feedback",
      status: "starting",
      createdAt: 300,
      latestAttentionAt: 300,
      runtime: {
        displayStatus: "starting",
        hostReconnectGraceExpiresAt: null,
      },
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_working",
      projectId: PROJECT_IDS.pierre,
      title: "Review prompt box spacing on iPhone",
      titleFallback: "Review prompt box spacing on iPhone",
      status: "active",
      createdAt: 250,
      latestAttentionAt: 250,
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_ready",
      title: "Backfill root compose tests",
      titleFallback: "Backfill root compose tests",
      createdAt: 200,
      latestAttentionAt: 200,
    },
  }),
];

const statusThreads: ThreadListEntry[] = [
  makeRecentThread({
    overrides: {
      id: "thr_mobile_pending",
      title: "Needs environment approval",
      titleFallback: "Needs environment approval",
      hasPendingInteraction: true,
      status: "active",
      createdAt: 500,
      latestAttentionAt: 500,
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_reconnecting",
      projectId: PROJECT_IDS.pierre,
      title: "Host reconnecting after sleep",
      titleFallback: "Host reconnecting after sleep",
      status: "active",
      createdAt: 450,
      latestAttentionAt: 450,
      runtime: {
        displayStatus: "host-reconnecting",
        hostReconnectGraceExpiresAt: 600,
      },
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_error",
      title: "Runtime failed to start",
      titleFallback: "Runtime failed to start",
      status: "error",
      createdAt: 400,
      latestAttentionAt: 400,
      runtime: {
        displayStatus: "error",
        hostReconnectGraceExpiresAt: null,
      },
    },
  }),
];

const metadataThreads: ThreadListEntry[] = [
  makeRecentThread({
    overrides: {
      id: "thr_mobile_worktree",
      title: "Anchor the mobile prompt box",
      titleFallback: "Anchor the mobile prompt box",
      environmentName: "mobile-home",
      environmentBranchName: "bb/mobile-home",
      environmentWorkspaceDisplayKind: "managed-worktree",
      createdAt: 700,
      latestAttentionAt: 700,
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_unread",
      projectId: PROJECT_IDS.pierre,
      title: "Finished while you were away",
      titleFallback: "Finished while you were away",
      status: "idle",
      lastReadAt: 100,
      createdAt: 650,
      latestAttentionAt: 650,
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_long_title",
      title:
        "A deliberately long thread title that has to truncate on a narrow mobile row",
      titleFallback: "A deliberately long thread title",
      environmentBranchName: "bb/very-long-branch-name-for-truncation",
      environmentWorkspaceDisplayKind: "unmanaged-worktree",
      createdAt: 600,
      latestAttentionAt: 600,
    },
  }),
];

const hierarchyThreads: ThreadListEntry[] = [
  makeRecentThread({
    overrides: {
      id: "thr_mobile_parent",
      title: "Rework folder model",
      titleFallback: "Rework folder model",
      status: "active",
      createdAt: 900,
      latestAttentionAt: 900,
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_child_a",
      providerId: "claude-code",
      parentThreadId: "thr_mobile_parent",
      title: "Audit folder query paths",
      titleFallback: "Audit folder query paths",
      status: "active",
      createdAt: 880,
      latestAttentionAt: 880,
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_child_b",
      parentThreadId: "thr_mobile_parent",
      title: "Migrate folder fixtures",
      titleFallback: "Migrate folder fixtures",
      createdAt: 860,
      latestAttentionAt: 860,
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_grandchild",
      providerId: "acp-cursor",
      parentThreadId: "thr_mobile_child_a",
      title: "Backfill folder migration tests",
      titleFallback: "Backfill folder migration tests",
      createdAt: 850,
      latestAttentionAt: 850,
    },
  }),
  makeRecentThread({
    overrides: {
      id: "thr_mobile_sibling",
      projectId: PROJECT_IDS.pierre,
      title: "Unrelated top-level thread",
      titleFallback: "Unrelated top-level thread",
      createdAt: 840,
      latestAttentionAt: 840,
    },
  }),
];

const projectNamesById = new Map<string, string>([
  [PROJECT_IDS.bb, PROJECT_NAMES.bb],
  [PROJECT_IDS.pierre, PROJECT_NAMES.pierre],
]);

const providersById = STORY_PROVIDERS_BY_ID;

export function Overview() {
  return (
    <StoryCard labelWidth="170px">
      <StoryRow label="just starting">
        <MobileStage>
          <RootComposeMobileRecents
            highlightedThreadId="thr_mobile_just_starting"
            projectNamesById={projectNamesById}
            providersById={providersById}
            showCreatingRow={false}
            threads={recentThreads}
          />
        </MobileStage>
      </StoryRow>
      <StoryRow label="creating">
        <MobileStage>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={projectNamesById}
            providersById={providersById}
            showCreatingRow
            threads={recentThreads.slice(1)}
          />
        </MobileStage>
      </StoryRow>
      <StoryRow label="parent / child">
        <MobileStage>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={projectNamesById}
            providersById={providersById}
            showCreatingRow={false}
            threads={hierarchyThreads}
          />
        </MobileStage>
      </StoryRow>
      <StoryRow label="row metadata">
        <MobileStage>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={projectNamesById}
            providersById={providersById}
            showCreatingRow={false}
            threads={metadataThreads}
          />
        </MobileStage>
      </StoryRow>
      <StoryRow label="status variants">
        <MobileStage>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={projectNamesById}
            providersById={providersById}
            showCreatingRow={false}
            threads={statusThreads}
          />
        </MobileStage>
      </StoryRow>
    </StoryCard>
  );
}
