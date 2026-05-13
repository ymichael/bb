import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { FileContents } from "@pierre/diffs";
import { toast } from "sonner";
import {
  GIT_DIFF_VIEW_BASE_OPTIONS,
  GitDiffCard,
} from "../git-diff/GitDiffCard";
import {
  GitDiffToolbar,
  type GitDiffDisplayMode,
  type GitDiffSelectionOption,
} from "./GitDiffToolbar";
import {
  parseGitDiffFiles,
  summarizeGitDiff,
  type ParsedGitDiffFile,
} from "../git-diff/git-diff-parsing";
import { usePreferredTheme } from "@/hooks/useTheme";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "secondary-panel/Diff",
};

// Mirror the secondary panel: bordered, white background, toolbar at top,
// cards in a scrolling region underneath. Keeps the visual context honest.
function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[760px] min-w-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background pt-3">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Realistic file fixtures. Each fixture is a fake-but-plausible TypeScript
// source file (~100-200 lines) used as the OLD side of the diff; edits
// transform it into the NEW side, and `buildAlignedDiff` synthesizes the
// matching unified diff so the library's own line-arrays line up with our
// hunk metadata once contents load. That's what unlocks expand-context
// buttons in every gap between hunks.
// ---------------------------------------------------------------------------

const PROJECT_ROW_TSX = `import {
  type CSSProperties,
  memo,
  useMemo,
} from "react";
import { Icon } from "@/components/ui/icon.js";
import { Sidebar, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton } from "@/components/ui/sidebar.js";
import { useThreadList } from "@/hooks/queries/thread-queries";
import type { Project } from "@bb/domain";
import { ThreadRow } from "./ThreadRow";

export interface ProjectRowProps {
  project: Project;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}

const PROJECT_ROW_STYLE: CSSProperties = {
  contain: "layout paint",
};

interface ProjectThreadGroup {
  managerId: string | null;
  threadIds: readonly string[];
}

function buildProjectThreadGroups(
  threadIds: readonly string[],
  parentByThreadId: Record<string, string | null>,
): ProjectThreadGroup[] {
  const groups: ProjectThreadGroup[] = [];
  const indexByManagerId = new Map<string | null, number>();
  for (const threadId of threadIds) {
    const managerId = parentByThreadId[threadId] ?? null;
    const existing = indexByManagerId.get(managerId);
    if (existing !== undefined) {
      groups[existing] = {
        ...groups[existing]!,
        threadIds: [...groups[existing]!.threadIds, threadId],
      };
      continue;
    }
    indexByManagerId.set(managerId, groups.length);
    groups.push({ managerId, threadIds: [threadId] });
  }
  return groups;
}

function ProjectRowComponent({
  project,
  isCollapsed,
  onToggleCollapsed,
}: ProjectRowProps) {
  const threadListState = useThreadList({ projectId: project.id });
  const projectThreads = useMemo(
    () => threadListState.data?.threads ?? [],
    [threadListState.data?.threads],
  );
  return (
    <SidebarMenuItem className="group/project" style={PROJECT_ROW_STYLE}>
      <SidebarMenuButton
        type="button"
        onClick={onToggleCollapsed}
        className="font-medium text-sidebar-foreground"
        aria-expanded={!isCollapsed}
        aria-label={\`\${isCollapsed ? "Expand" : "Collapse"} \${project.name}\`}
      >
        <Icon name="ChevronRight"
          className={
            isCollapsed
              ? "size-3.5 shrink-0 transition-transform"
              : "size-3.5 shrink-0 rotate-90 transition-transform"
          }
        />
        <span className="truncate">{project.name}</span>
      </SidebarMenuButton>
      {!isCollapsed ? (
        threadListState.status === "loading" ? (
          <div className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuSkeleton />
          </div>
        ) : projectThreads.length > 0 ? (
          <div className="space-y-0.5 group-data-[collapsible=icon]:hidden">
            {projectThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </div>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No threads in this project yet.
          </p>
        )
      ) : null}
    </SidebarMenuItem>
  );
}

export const ProjectRow = memo(ProjectRowComponent);
ProjectRow.displayName = "ProjectRow";
`;

const THREAD_ROW_TSX = `import { memo, useMemo } from "react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar.js";
import { StatusPill } from "@/components/ui/status-pill.js";
import { cn } from "@/lib/utils";
import { getEnvironmentWorkspaceDisplayIconName } from "@/lib/environment-workspace-display";
import type { ThreadListEntry } from "@bb/server-contract";

export interface ThreadRowProps {
  thread: ThreadListEntry;
  isActive: boolean;
  managerOptions?: ThreadRowManagerOptions;
  onSelect: () => void;
}

export interface ThreadRowManagerOptions {
  isCollapsed: boolean;
  managedChildCount: number;
  managedChildBusyCount: number;
  onToggleCollapsed: () => void;
}

function isThreadBusy(thread: ThreadListEntry): boolean {
  switch (thread.runtime.displayStatus) {
    case "active":
    case "host-reconnecting":
      return true;
    case "idle":
    case "interrupted":
    case "failed":
      return false;
  }
}

function ThreadRowComponent({
  thread,
  isActive,
  managerOptions,
  onSelect,
}: ThreadRowProps) {
  const threadIsBusy = isThreadBusy(thread);
  const isManager = thread.type === "manager";
  const isManagerCollapsed = managerOptions?.isCollapsed ?? false;
  const managedChildCount = managerOptions?.managedChildCount ?? 0;
  const hasManagedChildren = managedChildCount > 0;
  const managedChildBusyCount = managerOptions?.managedChildBusyCount ?? 0;
  const isManagerBusy =
    isManager && (threadIsBusy || managedChildBusyCount > 0);
  const environmentIcon = getEnvironmentWorkspaceDisplayIconName(
    thread.environmentWorkspaceDisplayKind,
  );
  const titleText = useMemo(
    () => thread.title?.trim() || thread.titleFallback || "Untitled thread",
    [thread.title, thread.titleFallback],
  );
  return (
    <SidebarMenuItem className="group/thread">
      <SidebarMenuButton
        type="button"
        onClick={onSelect}
        isActive={isActive}
        className="text-sm text-sidebar-foreground"
      >
        {isManagerBusy ? (
          <Icon name="Spinner" className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          environmentIcon ? (
            <Icon
              name={environmentIcon}
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">{titleText}</span>
          {isManager && hasManagedChildren ? (
            <span className="text-xs text-muted-foreground">
              {managedChildCount}
            </span>
          ) : null}
        </span>
        {isManager ? (
          <StatusPill variant="outline" className="shrink-0">
            manager
          </StatusPill>
        ) : null}
      </SidebarMenuButton>
      <span
        className={cn(
          "flex shrink-0 items-center justify-end",
          managerOptions?.isCollapsed ? "opacity-50" : undefined,
        )}
      >
        {isManager ? (
          <button
            type="button"
            onClick={managerOptions?.onToggleCollapsed}
            aria-label={isManagerCollapsed ? "Expand children" : "Collapse children"}
          >
            chevron
          </button>
        ) : null}
      </span>
    </SidebarMenuItem>
  );
}

export const ThreadRow = memo(ThreadRowComponent);
ThreadRow.displayName = "ThreadRow";
`;

const PROJECT_ROW_STORIES_TSX = `import type { ReactNode } from "react";
import { ProjectRow } from "./ProjectRow";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "sidebar/Project Row",
};

function StoryStage({ children }: { children: ReactNode }) {
  return <div className="w-72">{children}</div>;
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="collapsed">
        <StoryStage>
          <ProjectRow
            project={{ id: "proj_demo", name: "demo" } as never}
            isCollapsed
            onToggleCollapsed={() => {}}
          />
        </StoryStage>
      </StoryRow>
      <StoryRow label="expanded">
        <StoryStage>
          <ProjectRow
            project={{ id: "proj_demo", name: "demo" } as never}
            isCollapsed={false}
            onToggleCollapsed={() => {}}
          />
        </StoryStage>
      </StoryRow>
    </StoryCard>
  );
}
`;

// ---------------------------------------------------------------------------
// Aligned-fixture builders. Each takes a real-looking source file plus an
// edit list and produces the FileContents pair AND the unified diff that
// describes the change between them. Once GitDiffCard tags the file lines
// onto the parsed fileDiff, the library shows expand-context buttons in
// every gap between hunks.
// ---------------------------------------------------------------------------

interface AlignedDiffEdit {
  /** 1-based line number to replace. */
  line: number;
  /** New text for that line; oldText is read from `oldContent`. */
  newText: string;
}

interface AlignedDiffSpec {
  filename: string;
  oldContent: string;
  edits: readonly AlignedDiffEdit[];
}

interface AlignedDiffResult {
  oldFile: FileContents;
  newFile: FileContents;
  unifiedDiff: string;
}

const ALIGNED_DIFF_CONTEXT = 3;

function buildAlignedDiff(spec: AlignedDiffSpec): AlignedDiffResult {
  const oldLines = spec.oldContent.split("\n");
  for (const edit of spec.edits) {
    if (edit.line < 1 || edit.line > oldLines.length) {
      throw new Error(
        `buildAlignedDiff: ${spec.filename} has ${oldLines.length} lines; cannot edit line ${edit.line}`,
      );
    }
    if (oldLines[edit.line - 1] === edit.newText) {
      throw new Error(
        `buildAlignedDiff: ${spec.filename} line ${edit.line} is identical to newText — diff would be empty`,
      );
    }
  }
  const newLines = [...oldLines];
  for (const edit of spec.edits) {
    newLines[edit.line - 1] = edit.newText;
  }

  // Sort edits by line so hunks come out in order; collapse adjacent edits
  // into a single hunk when their context regions overlap (keeps the diff
  // looking like real `git diff` output).
  const sortedEdits = [...spec.edits].sort((a, b) => a.line - b.line);
  const hunkRanges: Array<{ start: number; end: number; lines: number[] }> = [];
  for (const edit of sortedEdits) {
    const rangeStart = Math.max(1, edit.line - ALIGNED_DIFF_CONTEXT);
    const rangeEnd = Math.min(oldLines.length, edit.line + ALIGNED_DIFF_CONTEXT);
    const last = hunkRanges[hunkRanges.length - 1];
    if (last && last.end >= rangeStart - 1) {
      last.end = Math.max(last.end, rangeEnd);
      last.lines.push(edit.line);
    } else {
      hunkRanges.push({ start: rangeStart, end: rangeEnd, lines: [edit.line] });
    }
  }

  const hunkBlocks = hunkRanges.map(({ start, end, lines }) => {
    const editLines = new Set(lines);
    const range = end - start + 1;
    const body: string[] = [];
    for (let n = start; n <= end; n++) {
      if (editLines.has(n)) {
        body.push(`-${oldLines[n - 1]}`);
        body.push(`+${newLines[n - 1]}`);
      } else {
        body.push(` ${oldLines[n - 1]}`);
      }
    }
    return `@@ -${start},${range} +${start},${range} @@\n${body.join("\n")}`;
  });

  const unifiedDiff = `diff --git a/${spec.filename} b/${spec.filename}
index 1111111..2222222 100644
--- a/${spec.filename}
+++ b/${spec.filename}
${hunkBlocks.join("\n")}
`;

  return {
    oldFile: { name: spec.filename, contents: oldLines.join("\n") },
    newFile: { name: spec.filename, contents: newLines.join("\n") },
    unifiedDiff,
  };
}

function buildNewFileDiff(filename: string, content: string): AlignedDiffResult {
  const lines = content.split("\n");
  const trailingEmpty = lines[lines.length - 1] === "" ? 1 : 0;
  const lineCount = lines.length - trailingEmpty;
  const body = lines
    .slice(0, lineCount)
    .map((line) => `+${line}`)
    .join("\n");
  return {
    oldFile: { name: filename, contents: "" },
    newFile: { name: filename, contents: content },
    unifiedDiff: `diff --git a/${filename} b/${filename}
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/${filename}
@@ -0,0 +1,${lineCount} @@
${body}
`,
  };
}

function buildRenameDiff(
  oldName: string,
  newName: string,
  content: string,
): AlignedDiffResult {
  return {
    oldFile: { name: oldName, contents: content },
    newFile: { name: newName, contents: content },
    unifiedDiff: `diff --git a/${oldName} b/${newName}
similarity index 100%
rename from ${oldName}
rename to ${newName}
`,
  };
}

// ---------------------------------------------------------------------------
// Fixtures: each story row is backed by a real-looking file + matching diff.
// ---------------------------------------------------------------------------

const SMALL = buildAlignedDiff({
  filename: "apps/app/src/components/sidebar/ProjectRow.tsx",
  oldContent: PROJECT_ROW_TSX,
  edits: [
    {
      line: 85,
      newText: "            <SidebarMenuSkeleton showIcon />",
    },
  ],
});

const LARGER = buildAlignedDiff({
  filename: "apps/app/src/components/sidebar/ThreadRow.tsx",
  oldContent: THREAD_ROW_TSX,
  edits: [
    {
      line: 47,
      newText:
        "  const isManagerCollapsed = managerOptions?.isCollapsed ?? !hasManagedChildren;",
    },
    {
      line: 52,
      newText:
        "    isManager && (threadIsBusy || (isManagerCollapsed && managedChildBusyCount > 0));",
    },
    {
      line: 89,
      newText: '        <Pill variant="emphasis" className="shrink-0">',
    },
  ],
});

const NEW_FILE = buildNewFileDiff(
  "apps/app/src/components/sidebar/ProjectRow.stories.tsx",
  PROJECT_ROW_STORIES_TSX,
);

const RENAMED = buildRenameDiff(
  "apps/app/src/components/layout/AppSidebar.tsx",
  "apps/app/src/components/sidebar/AppSidebar.tsx",
  PROJECT_ROW_TSX,
);

const ALL_FIXTURES = [SMALL, LARGER, NEW_FILE, RENAMED] as const;

const SELECTION_OPTIONS: readonly GitDiffSelectionOption[] = [
  { value: "working", label: "Working changes" },
  {
    value: "cce1f4c65",
    label: "refactor(sidebar): consolidate components/sidebar",
    monoPrefix: "cce1f4c6",
  },
  {
    value: "f09726756",
    label: "fix(integration-tests): align with new pendingTodos",
    monoPrefix: "f0972675",
  },
];

interface InteractiveDiffPanelDiff {
  fileKey: string;
  fixture: AlignedDiffResult;
}

interface InteractiveDiffPanelArgs {
  diffs: readonly InteractiveDiffPanelDiff[];
  /** Pre-collapse certain files. */
  initialCollapsed?: ReadonlySet<string>;
  /** Pretend the syntax-highlighting worker hasn't enqueued yet for a file. */
  renderingFileKeys?: ReadonlySet<string>;
}

function InteractiveDiffPanel({
  diffs,
  initialCollapsed,
  renderingFileKeys,
}: InteractiveDiffPanelArgs) {
  const parsed = useMemo(
    () =>
      diffs
        .map(({ fileKey, fixture }) => ({
          fileKey,
          fileDiff: parseGitDiffFiles(fixture.unifiedDiff)[0],
          fullDiff: fixture.unifiedDiff,
          fixture,
        }))
        .filter(
          (
            entry,
          ): entry is {
            fileKey: string;
            fileDiff: ParsedGitDiffFile;
            fullDiff: string;
            fixture: AlignedDiffResult;
          } => entry.fileDiff !== undefined,
        ),
    [diffs],
  );
  const aggregateStats = useMemo(
    () =>
      summarizeGitDiff(
        parsed.map((p) => p.fileDiff),
        parsed.map((p) => p.fullDiff).join("\n"),
      ),
    [parsed],
  );
  const preferredTheme = usePreferredTheme();
  const [selection, setSelection] = useState("working");
  const [displayMode, setDisplayMode] = useState<GitDiffDisplayMode>("unified");
  const [collapsedFileKeys, setCollapsedFileKeys] = useState<Set<string>>(
    () => new Set(initialCollapsed ?? []),
  );
  const allCollapsed =
    parsed.length > 0 &&
    parsed.every(({ fileKey }) => collapsedFileKeys.has(fileKey));
  const toggleAllCollapsed = useCallback(() => {
    setCollapsedFileKeys((current) => {
      if (parsed.every(({ fileKey }) => current.has(fileKey))) {
        return new Set();
      }
      return new Set(parsed.map(({ fileKey }) => fileKey));
    });
  }, [parsed]);
  const toggleFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);
  const viewOptions = useMemo(
    () => ({
      ...GIT_DIFF_VIEW_BASE_OPTIONS,
      diffStyle: displayMode,
      themeType: preferredTheme,
    }),
    [displayMode, preferredTheme],
  );
  const onOpenFileInEditor = useCallback((path: string) => {
    toast.message("Opening in editor", { description: path });
  }, []);

  // Single panel-level fetcher that mirrors production: looks up the right
  // FileContents by path. Cards don't need to know which fixture they came
  // from; they just call onRequestFileContents(path, side).
  const contentsByPath = useMemo(() => {
    const map = new Map<string, { old: FileContents; new: FileContents }>();
    for (const { fixture } of parsed) {
      map.set(fixture.newFile.name, {
        old: fixture.oldFile,
        new: fixture.newFile,
      });
      if (fixture.oldFile.name !== fixture.newFile.name) {
        map.set(fixture.oldFile.name, {
          old: fixture.oldFile,
          new: fixture.newFile,
        });
      }
    }
    return map;
  }, [parsed]);
  const onRequestFileContents = useCallback(
    (path: string, side: "old" | "new") => {
      const entry = contentsByPath.get(path);
      if (!entry) return Promise.resolve(null);
      return Promise.resolve(side === "old" ? entry.old : entry.new);
    },
    [contentsByPath],
  );

  return (
    <PanelStage>
      <GitDiffToolbar
        selectionValue={selection}
        selectionOptions={SELECTION_OPTIONS}
        onSelectionChange={setSelection}
        isSelectorDisabled={false}
        stats={aggregateStats}
        isParsing={false}
        areAllFilesCollapsed={allCollapsed}
        isCollapseAllDisabled={parsed.length === 0}
        onToggleAllCollapsed={toggleAllCollapsed}
        displayMode={displayMode}
        onDisplayModeChange={setDisplayMode}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        <div className="space-y-2">
          {parsed.map(({ fileKey, fileDiff }) => (
            <GitDiffCard
              key={fileKey}
              fileDiff={fileDiff}
              diffViewOptions={viewOptions}
              onOpenFileInEditor={onOpenFileInEditor}
              isCollapsed={collapsedFileKeys.has(fileKey)}
              onToggleCollapsed={() => toggleFileCollapsed(fileKey)}
              stickyHeader
              isRendering={renderingFileKeys?.has(fileKey) ?? false}
              onRequestFileContents={onRequestFileContents}
            />
          ))}
        </div>
      </div>
    </PanelStage>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="modified file"
        hint="single hunk in a real-looking ProjectRow.tsx; click ↑/↓/⇅ in the gaps to expand 30 lines at a time"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "small", fixture: SMALL }]}
        />
      </StoryRow>
      <StoryRow
        label="multi-hunk"
        hint="three small hunks in a single file — same expand affordances between hunks and at the file edges"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "larger", fixture: LARGER }]}
        />
      </StoryRow>
      <StoryRow
        label="new file"
        hint="entire file is added; no expand UI (nothing to expand into on the old side)"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "new", fixture: NEW_FILE }]}
        />
      </StoryRow>
      <StoryRow
        label="rename"
        hint="similarity index 100% — pure rename, no content delta"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "rename", fixture: RENAMED }]}
        />
      </StoryRow>
      <StoryRow
        label="multi-file working changes"
        hint="all four file shapes in one panel — collapse-all, view-mode toggle, per-file collapse"
      >
        <InteractiveDiffPanel
          diffs={ALL_FIXTURES.map((fixture, i) => ({
            fileKey: `multi-${i}`,
            fixture,
          }))}
        />
      </StoryRow>
      <StoryRow
        label="rendering pending"
        hint="syntax-highlighting worker hasn't enqueued the larger file yet — body shows a skeleton"
      >
        <InteractiveDiffPanel
          diffs={[
            { fileKey: "small", fixture: SMALL },
            { fileKey: "larger", fixture: LARGER },
          ]}
          renderingFileKeys={new Set(["larger"])}
        />
      </StoryRow>
    </StoryCard>
  );
}
