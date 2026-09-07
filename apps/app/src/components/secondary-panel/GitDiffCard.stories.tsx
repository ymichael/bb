import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { FileContents } from "@pierre/diffs";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { GitDiffCard } from "../git-diff/GitDiffCard";
import type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "@/components/git-diff/GitDiffCardBody";
import {
  DEFAULT_CODE_OVERFLOW_MODE,
  type CodeOverflowMode,
} from "@/lib/code-overflow-mode";
import {
  GitDiffToolbar,
  type GitDiffDisplayMode,
  type GitDiffSelectionOption,
} from "./GitDiffToolbar";
import {
  parseGitDiffFiles,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "../git-diff/git-diff-parsing";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { appToast } from "@/components/ui/app-toast";

export default {
  title: "right-panel/Diff",
};

function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[760px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background pt-3">
      {children}
    </div>
  );
}

const PROJECT_ROW_TSX = `import {
  type CSSProperties,
  memo,
  useMemo,
} from "react";
import { Icon } from "@bb/shared-ui/icon";
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
  parentId: string | null;
  threadIds: readonly string[];
}

function buildProjectThreadGroups(
  threadIds: readonly string[],
  parentByThreadId: Record<string, string | null>,
): ProjectThreadGroup[] {
  const groups: ProjectThreadGroup[] = [];
  const indexByParentId = new Map<string | null, number>();
  for (const threadId of threadIds) {
    const parentId = parentByThreadId[threadId] ?? null;
    const existing = indexByParentId.get(parentId);
    if (existing !== undefined) {
      groups[existing] = {
        ...groups[existing]!,
        threadIds: [...groups[existing]!.threadIds, threadId],
      };
      continue;
    }
    indexByParentId.set(parentId, groups.length);
    groups.push({ parentId, threadIds: [threadId] });
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
import { Pill } from "@bb/shared-ui/pill";
import { cn } from "@bb/shared-ui/lib/utils";
import { getEnvironmentWorkspaceDisplayIconName } from "@/lib/environment-workspace-display";
import type { ThreadListEntry } from "@bb/server-contract";

export interface ThreadRowProps {
  thread: ThreadListEntry;
  isActive: boolean;
  parentOptions?: ThreadRowParentOptions;
  onSelect: () => void;
}

export interface ThreadRowParentOptions {
  isCollapsed: boolean;
  childCount: number;
  childBusyCount: number;
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
  parentOptions,
  onSelect,
}: ThreadRowProps) {
  const threadIsBusy = isThreadBusy(thread);
  const childCount = parentOptions?.childCount ?? 0;
  const hasChildren = childCount > 0;
  const isParent = hasChildren;
  const isParentCollapsed = parentOptions?.isCollapsed ?? false;
  const childBusyCount = parentOptions?.childBusyCount ?? 0;
  const isParentBusy =
    isParent && (threadIsBusy || childBusyCount > 0);
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
        {isParentBusy ? (
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
          {isParent && hasChildren ? (
            <span className="text-xs text-muted-foreground">
              {childCount}
            </span>
          ) : null}
        </span>
        {isParent ? (
          <Pill variant="outline" className="shrink-0">parent</Pill>
        ) : null}
      </SidebarMenuButton>
      <span
        className={cn(
          "flex shrink-0 items-center justify-end",
          parentOptions?.isCollapsed ? "opacity-50" : undefined,
        )}
      >
        {isParent ? (
          <button
            type="button"
            onClick={parentOptions?.onToggleCollapsed}
            aria-label={isParentCollapsed ? "Expand children" : "Collapse children"}
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

interface AlignedDiffEdit {
  line: number;
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

interface FileContentDiffSpec {
  filename: string;
  content: string;
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

  const sortedEdits = [...spec.edits].sort((a, b) => a.line - b.line);
  const hunkRanges: Array<{ start: number; end: number; lines: number[] }> = [];
  for (const edit of sortedEdits) {
    const rangeStart = Math.max(1, edit.line - ALIGNED_DIFF_CONTEXT);
    const rangeEnd = Math.min(
      oldLines.length,
      edit.line + ALIGNED_DIFF_CONTEXT,
    );
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

function buildNewFileDiff(
  filename: string,
  content: string,
): AlignedDiffResult {
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

function buildDeletedFileDiff({
  filename,
  content,
}: FileContentDiffSpec): AlignedDiffResult {
  const lines = content.split("\n");
  const trailingEmpty = lines[lines.length - 1] === "" ? 1 : 0;
  const lineCount = lines.length - trailingEmpty;
  const body = lines
    .slice(0, lineCount)
    .map((line) => `-${line}`)
    .join("\n");
  return {
    oldFile: { name: filename, contents: content },
    newFile: { name: filename, contents: "" },
    unifiedDiff: `diff --git a/${filename} b/${filename}
deleted file mode 100644
index 3333333..0000000
--- a/${filename}
+++ /dev/null
@@ -1,${lineCount} +0,0 @@
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
        "  const isParentCollapsed = parentOptions?.isCollapsed ?? !hasChildren;",
    },
    {
      line: 52,
      newText:
        "    isParent && (threadIsBusy || (isParentCollapsed && childBusyCount > 0));",
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

const DELETED_FILE = buildDeletedFileDiff({
  filename: "apps/app/src/components/sidebar/legacy-thread-groups.ts",
  content: THREAD_ROW_TSX,
});

const RENAMED = buildRenameDiff(
  "apps/app/src/components/layout/AppSidebar.tsx",
  "apps/app/src/components/sidebar/AppSidebar.tsx",
  PROJECT_ROW_TSX,
);

const ALL_FIXTURES = [SMALL, LARGER, NEW_FILE, DELETED_FILE, RENAMED] as const;

interface ImageDiffResult {
  unifiedDiff: string;
  filename: string;
  oldImageUrl: string | null;
  newImageUrl: string | null;
  oldSizeBytes: number | null;
  newSizeBytes: number | null;
}

interface ImageDiffSide {
  url: string;
  sizeBytes: number;
}

const OLD_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABM0lEQVR42u3c2W3EMAwFwNfMVpay00G2hyCpYH8sSyQ9wKtgAB/ioby+3vIhQQAIECBAgAABAiSAAAECBAgQIEBSFej75/c/gD7pVDNKQZ1SRqmpU8coZXWKGKWyTgWjFNc5bpT6OmeN0kLnoFG66JwySiOdI0bppbPfKO10Nhulo85OozTV2WaUvjp7jNJaZ4NRuuvcbZQBOrcaZYbOfUYZo3OTUSbp3GGUYTrLjTJPZ61RRuosNMpUnVVGGayzxCizda4bZbzORaM8QeeKESCP2JFHzEvaZ96PoqOGw2qfw6pyh4KZkquivbaPxuGkxqHWs+EF4y8GqIzgGeI0BvysMWCD5FYRLLNYh7JQZyXTUq+1cGvhLhZwNYXLTQQQIECAAAECBAiQAAIECBAgQIAemD+n0rjUKA9l+AAAAABJRU5ErkJggg==";
const NEW_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABNUlEQVR42u3cyXHEMAwEwIlig3KaTsv/TcIPO4L9iCIBqKsmgq7SQRzM6/tLPiQIAAECBAgQIECABBAgQIAAAQIESKoC/fy+/wPok041oxTUKWWUmjp1jFJWp4hRKutUMEpxneNGqa9z1igtdA4apYvOKaM00jlilF46+43STmezUTrq7DRKU51tRumrs8corXU2GKW7zt1GGaBzq1Fm6NxnlDE6Nxllks4dRhmms9wo83TWGmWkzkKjTNVZZZTBOkuMMlvnulHG61w0yhN0rhgB8ogdecS8pH3m/Sg6ajis9jmsKncomCm5Ktpr+2gcTmocaj0bXjD+YoDKCJ4hTmPAzxoDNkhuFcEyi3UoC3VWMi31Wgu3Fu5iAVdTuNxEAAECBAgQIECAAAkgQIAAAQIE6IH5A7KtCNDxpTKzAAAAAElFTkSuQmCC";
const ADDED_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABNElEQVR42u3cuXEEMQwEwInu8neVgTz550iK4JzlkgC2qyaCrtqHeJiv1498SBAAAgQIECBAgAAJIECAAAECBAiQVAV6f//+B9AnnWpGKahTyig1deoYpaxOEaNU1qlglOI6x41SX+esUVroHDRKF51TRmmkc8QovXT2G6WdzmajdNTZaZSmOtuM0ldnj1Fa62wwSnedu40yQOdWo8zQuc8oY3RuMsoknTuMMkxnuVHm6aw1ykidhUaZqrPKKIN1lhhlts51o4zXuWiUJ+hcMQLkETvyiHlJ+8z7UXTUcFjtc1hV7lAwU3JVtNf20Tic1DjUeja8YPzFAJURPEOcxoCfNQZskNwqgmUW61AW6qxkWuq1Fm4t3MUCrqZwuYkAAgQIECBAgAABEkCAAAECBAjQA/MHNxr5rgQT6G0AAAAASUVORK5CYII=";

function buildAddedImageDiff(
  filename: string,
  dataUrl: string,
  sizeBytes: number,
): ImageDiffResult {
  return {
    filename,
    oldImageUrl: null,
    newImageUrl: dataUrl,
    oldSizeBytes: null,
    newSizeBytes: sizeBytes,
    unifiedDiff: `diff --git a/${filename} b/${filename}
new file mode 100644
index 0000000..1111111
GIT binary patch
literal 95
zcmeAS@N?(olHy\`uVBq!ia0vp^0wB!61|;P_|4#
`,
  };
}

function buildModifiedImageDiff(
  filename: string,
  oldSide: ImageDiffSide,
  newSide: ImageDiffSide,
): ImageDiffResult {
  return {
    filename,
    oldImageUrl: oldSide.url,
    newImageUrl: newSide.url,
    oldSizeBytes: oldSide.sizeBytes,
    newSizeBytes: newSide.sizeBytes,
    unifiedDiff: `diff --git a/${filename} b/${filename}
index 1111111..2222222 100644
GIT binary patch
delta 64
zcmV-G0Kfm_0q_7
delta 64
zcmV-G0Kfl_0q_8
`,
  };
}

function buildDeletedImageDiff(
  filename: string,
  dataUrl: string,
  sizeBytes: number,
): ImageDiffResult {
  return {
    filename,
    oldImageUrl: dataUrl,
    newImageUrl: null,
    oldSizeBytes: sizeBytes,
    newSizeBytes: null,
    unifiedDiff: `diff --git a/${filename} b/${filename}
deleted file mode 100644
index 1111111..0000000
GIT binary patch
literal 0
HcmV?d00001
`,
  };
}

const ADDED_IMAGE = buildAddedImageDiff(
  "apps/app/public/icons/logo-mark.png",
  ADDED_IMAGE_DATA_URL,
  18_432,
);

const MODIFIED_IMAGE = buildModifiedImageDiff(
  "apps/app/public/icons/logo-mark.png",
  { url: OLD_IMAGE_DATA_URL, sizeBytes: 18_432 },
  { url: NEW_IMAGE_DATA_URL, sizeBytes: 24_960 },
);

const DELETED_IMAGE = buildDeletedImageDiff(
  "apps/app/public/icons/legacy-logo.png",
  OLD_IMAGE_DATA_URL,
  12_288,
);

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

type DiffPanelFixture = AlignedDiffResult | ImageDiffResult;

interface InteractiveDiffPanelDiff {
  fileKey: string;
  fixture: DiffPanelFixture;
}

interface FixtureSideContents {
  paths: readonly string[];
  old: DiffFileContentsResult | null;
  new: DiffFileContentsResult | null;
}

function isImageDiffResult(
  fixture: DiffPanelFixture,
): fixture is ImageDiffResult {
  return "filename" in fixture;
}

function getFixtureSideContents(
  fixture: DiffPanelFixture,
): FixtureSideContents {
  if (isImageDiffResult(fixture)) {
    return {
      paths: [fixture.filename],
      old:
        fixture.oldImageUrl === null || fixture.oldSizeBytes === null
          ? null
          : {
              kind: "image",
              dataUrl: fixture.oldImageUrl,
              sizeBytes: fixture.oldSizeBytes,
            },
      new:
        fixture.newImageUrl === null || fixture.newSizeBytes === null
          ? null
          : {
              kind: "image",
              dataUrl: fixture.newImageUrl,
              sizeBytes: fixture.newSizeBytes,
            },
    };
  }
  const paths =
    fixture.oldFile.name === fixture.newFile.name
      ? [fixture.newFile.name]
      : [fixture.oldFile.name, fixture.newFile.name];
  return {
    paths,
    old: { kind: "text", file: fixture.oldFile },
    new: { kind: "text", file: fixture.newFile },
  };
}

interface InteractiveDiffPanelArgs {
  diffs: readonly InteractiveDiffPanelDiff[];
  initialCollapsed?: ReadonlySet<string>;
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
            fixture: DiffPanelFixture;
          } => entry.fileDiff !== undefined,
        ),
    [diffs],
  );
  const aggregateStats = useMemo(() => {
    let insertions = 0;
    let deletions = 0;
    for (const entry of parsed) {
      const fileStats = summarizeGitDiffFile(entry.fileDiff);
      insertions += fileStats.insertions;
      deletions += fileStats.deletions;
    }
    return { filesCount: parsed.length, insertions, deletions };
  }, [parsed]);
  const [selection, setSelection] = useState("working");
  const [displayMode, setDisplayMode] = useState<GitDiffDisplayMode>("unified");
  const [lineOverflowMode, setLineOverflowMode] = useState<CodeOverflowMode>(
    DEFAULT_CODE_OVERFLOW_MODE,
  );
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
  const presentation = useMemo<DiffPresentation>(
    () => ({
      view: displayMode,
      overflow: lineOverflowMode,
      showLineNumbers: true,
    }),
    [displayMode, lineOverflowMode],
  );
  const onOpenFileInEditor = useCallback((path: string) => {
    appToast.message("Opening in editor", { description: path });
  }, []);

  const contentsByPath = useMemo(() => {
    const map = new Map<
      string,
      { old: DiffFileContentsResult | null; new: DiffFileContentsResult | null }
    >();
    for (const { fixture } of parsed) {
      const sides = getFixtureSideContents(fixture);
      for (const path of sides.paths) {
        map.set(path, { old: sides.old, new: sides.new });
      }
    }
    return map;
  }, [parsed]);
  const onRequestFileContents = useCallback<RequestDiffFileContents>(
    (path, side) => {
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
        isTruncated={false}
        areAllFilesCollapsed={allCollapsed}
        isCollapseAllDisabled={parsed.length === 0}
        onToggleAllCollapsed={toggleAllCollapsed}
        displayMode={displayMode}
        onDisplayModeChange={setDisplayMode}
        lineOverflowMode={lineOverflowMode}
        onLineOverflowModeChange={setLineOverflowMode}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        <div className="space-y-2">
          {parsed.map(({ fileKey, fileDiff }) => (
            <GitDiffCard
              key={fileKey}
              fileDiff={fileDiff}
              presentation={presentation}
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
        <InteractiveDiffPanel diffs={[{ fileKey: "small", fixture: SMALL }]} />
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
        <InteractiveDiffPanel diffs={[{ fileKey: "new", fixture: NEW_FILE }]} />
      </StoryRow>
      <StoryRow
        label="deleted file"
        hint="expanded deletion shows a cheap placeholder first; Load diff mounts the expensive renderer"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "deleted", fixture: DELETED_FILE }]}
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
        label="added image"
        hint="header shows the new file's size as +18 KB; click the preview to open the lightbox"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "added-image", fixture: ADDED_IMAGE }]}
        />
      </StoryRow>
      <StoryRow
        label="modified image"
        hint="header shows new and old sizes as a +24 KB -18 KB pair (no net math); old + new stay on one row (no wrap); click to zoom and arrow between them"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "modified-image", fixture: MODIFIED_IMAGE }]}
        />
      </StoryRow>
      <StoryRow
        label="deleted image"
        hint="loads the preview + -12 KB header size on view; no Load diff gate (that's only for the expensive text-deletion renderer)"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "deleted-image", fixture: DELETED_IMAGE }]}
        />
      </StoryRow>
      <StoryRow
        label="multi-file working changes"
        hint="all five file shapes in one panel — collapse-all, view-mode toggle, per-file collapse"
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
