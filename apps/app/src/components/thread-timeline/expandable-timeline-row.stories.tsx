import type { ReactNode } from "react";
import type { TimelineTitle, TimelineTitleDecoration } from "@bb/thread-view";
import {
  ExpandableTimelineRow,
  type TimelineTitleActionResolver,
} from "./index";

export default {
  title: "Thread Timeline/ExpandableTimelineRow",
};

interface StoryTitleArgs {
  actionPath?: string;
  decoration?: TimelineTitleDecoration;
  label: string;
  prefix: string;
  shimmer?: boolean;
  tone?: TimelineTitle["tone"];
}

interface ExpandableRowPreviewProps {
  children: ReactNode;
  autoExpanded?: boolean;
  title: TimelineTitle;
}

function storyTitle({
  actionPath,
  decoration,
  label,
  prefix,
  shimmer = false,
  tone = "default",
}: StoryTitleArgs): TimelineTitle {
  const decorations: TimelineTitle["decorations"] = decoration
    ? [decoration]
    : [];
  return {
    action: actionPath ? { kind: "open-file-diff", path: actionPath } : null,
    decorations,
    plain: `${prefix} ${label}`,
    segments: [
      {
        text: prefix,
        em: false,
        shimmer: false,
        truncate: false,
      },
      {
        text: label,
        em: true,
        shimmer,
        truncate: true,
      },
    ],
    tone,
  };
}

const titleActionResolver: TimelineTitleActionResolver = () => {
  return () => undefined;
};

function ExpandableRowPreview({
  autoExpanded = false,
  children,
  title,
}: ExpandableRowPreviewProps) {
  return (
    <div className="rounded-md border border-border/70 bg-background p-2">
      <ExpandableTimelineRow
        autoExpanded={autoExpanded}
        title={title}
        onTitleAction={titleActionResolver}
        renderBody={() => children}
      />
    </div>
  );
}

export function States() {
  return (
    <div className="flex max-w-3xl flex-col gap-4 bg-background p-6 text-foreground">
      <ExpandableRowPreview
        autoExpanded
        title={storyTitle({
          prefix: "Ran",
          label: "pnpm exec turbo run typecheck --filter=@bb/app",
          decoration: {
            kind: "duration",
            startedAt: 1_000,
            completedAt: 3_600,
            em: false,
          },
        })}
      >
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs leading-5">
          typecheck passed
        </pre>
      </ExpandableRowPreview>
      <ExpandableRowPreview
        title={storyTitle({
          prefix: "Edited",
          label:
            "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          actionPath:
            "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          decoration: {
            kind: "diff-stats",
            added: 42,
            removed: 9,
          },
        })}
      >
        <p className="text-sm text-muted-foreground">
          Collapsed by default, with an actionable emphasized segment.
        </p>
      </ExpandableRowPreview>
      <ExpandableRowPreview
        title={storyTitle({
          prefix: "Failed",
          label: "pnpm exec turbo run test --filter=@bb/app",
          tone: "destructive",
          decoration: {
            kind: "status",
            status: "error",
            durationMs: 12_400,
          },
        })}
      >
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs leading-5 text-destructive">
          expected terminal output block to render failure output
        </pre>
      </ExpandableRowPreview>
      <ExpandableRowPreview
        title={storyTitle({
          prefix: "Summarized",
          label: "3 completed commands",
          tone: "summary",
          decoration: {
            kind: "summary-status",
            errorCount: 1,
            interruptedCount: 1,
          },
        })}
      >
        <p className="text-sm text-muted-foreground">
          Summary rows keep their muted treatment while still expanding.
        </p>
      </ExpandableRowPreview>
    </div>
  );
}
