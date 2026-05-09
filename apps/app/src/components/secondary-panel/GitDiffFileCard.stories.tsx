import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  GIT_DIFF_VIEW_BASE_OPTIONS,
  GitDiffFileCard,
} from "./ThreadSecondaryPanel";
import {
  GitDiffToolbar,
  type GitDiffDisplayMode,
  type GitDiffSelectionOption,
} from "./GitDiffToolbar";
import {
  parseGitDiffFiles,
  summarizeGitDiff,
  type ParsedGitDiffFile,
} from "./git-diff/git-diff-parsing";
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

const SMALL_DIFF = `diff --git a/apps/app/src/components/sidebar/ProjectRow.tsx b/apps/app/src/components/sidebar/ProjectRow.tsx
index 1111111..2222222 100644
--- a/apps/app/src/components/sidebar/ProjectRow.tsx
+++ b/apps/app/src/components/sidebar/ProjectRow.tsx
@@ -169,7 +169,7 @@ export function ProjectRow({
       {!isCollapsed ? (
         threadListState.status === "loading" ? (
           <div className="group-data-[collapsible=icon]:hidden">
-            <SidebarMenuSkeleton />
+            <SidebarMenuSkeleton showIcon />
           </div>
         ) : projectThreads.length > 0 ? (
           <div className="space-y-0.5 group-data-[collapsible=icon]:hidden">
`;

const NEW_FILE_DIFF = `diff --git a/apps/app/src/components/sidebar/ProjectRow.stories.tsx b/apps/app/src/components/sidebar/ProjectRow.stories.tsx
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/apps/app/src/components/sidebar/ProjectRow.stories.tsx
@@ -0,0 +1,12 @@
+import type { ReactNode } from "react";
+import { ProjectRow } from "./ProjectRow";
+
+export default {
+  title: "sidebar/Projects",
+};
+
+export function Overview() {
+  return (
+    <div>Story stub</div>
+  );
+}
`;

const RENAME_DIFF = `diff --git a/apps/app/src/components/layout/AppSidebar.tsx b/apps/app/src/components/sidebar/AppSidebar.tsx
similarity index 100%
rename from apps/app/src/components/layout/AppSidebar.tsx
rename to apps/app/src/components/sidebar/AppSidebar.tsx
`;

const LARGER_DIFF = `diff --git a/apps/app/src/components/sidebar/ThreadRow.tsx b/apps/app/src/components/sidebar/ThreadRow.tsx
index 4444444..5555555 100644
--- a/apps/app/src/components/sidebar/ThreadRow.tsx
+++ b/apps/app/src/components/sidebar/ThreadRow.tsx
@@ -278,9 +278,11 @@ function ThreadRowComponent({
   const isManagerCollapsed = managerOptions?.isCollapsed ?? false;
   const managedChildCount = managerOptions?.managedChildCount ?? 0;
   const hasManagedChildren = managedChildCount > 0;
   const managedChildBusyCount = managerOptions?.managedChildBusyCount ?? 0;
-  const isManagerBusy =
-    isManager && (threadIsBusy || managedChildBusyCount > 0);
+  const isManagerBusy =
+    isManager &&
+    (threadIsBusy ||
+      (isManagerCollapsed && managedChildBusyCount > 0));
   const EnvironmentIcon = getEnvironmentWorkspaceDisplayIcon(
     thread.environmentWorkspaceDisplayKind,
   );
@@ -337,11 +339,16 @@ function ThreadRowComponent({
         {isManager ? (
           <StatusPill variant="outline" className="shrink-0">
             manager
           </StatusPill>
         ) : null}
+        {isPromoted ? (
+          <Pill variant="emphasis" className="shrink-0">
+            promoted
+          </Pill>
+        ) : null}
       </span>
-      {isPromoted ? (
-        <Pill variant="emphasis" className="relative z-10">
-          promoted
-        </Pill>
-      ) : null}
       <span
         className={cn(
           "flex shrink-0 items-center justify-end",
`;

// ---------------------------------------------------------------------------
// Realistic selector fixtures — mimic what useGitDiffPanelState produces:
// "Working changes" plus a few recent commits.
// ---------------------------------------------------------------------------

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

interface InteractiveDiffPanelArgs {
  diffs: readonly { fileKey: string; diffText: string }[];
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
        .map(({ fileKey, diffText }) => ({
          fileKey,
          fileDiff: parseGitDiffFiles(diffText)[0],
          fullDiff: diffText,
        }))
        .filter(
          (entry): entry is { fileKey: string; fileDiff: ParsedGitDiffFile; fullDiff: string } =>
            entry.fileDiff !== undefined,
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
  const setRef = useCallback(() => {}, []);
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
            <GitDiffFileCard
              key={fileKey}
              fileKey={fileKey}
              fileDiff={fileDiff}
              threadId="thr_demo"
              isCollapsed={collapsedFileKeys.has(fileKey)}
              isRendering={renderingFileKeys?.has(fileKey) ?? false}
              setGitDiffFileRef={setRef}
              toggleGitDiffFileCollapsed={toggleFileCollapsed}
              gitDiffViewOptions={viewOptions}
              onOpenFileInEditor={onOpenFileInEditor}
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
        hint="single hunk; chevron toggles collapse, header click opens an editor toast"
      >
        <InteractiveDiffPanel
          diffs={[{ fileKey: "small", diffText: SMALL_DIFF }]}
        />
      </StoryRow>
      <StoryRow
        label="multi-file working changes"
        hint="four files in one panel — collapse-all, view-mode toggle, and per-file collapse all live"
      >
        <InteractiveDiffPanel
          diffs={[
            { fileKey: "small", diffText: SMALL_DIFF },
            { fileKey: "larger", diffText: LARGER_DIFF },
            { fileKey: "new", diffText: NEW_FILE_DIFF },
            { fileKey: "rename", diffText: RENAME_DIFF },
          ]}
        />
      </StoryRow>
      <StoryRow
        label="rendering pending"
        hint="the syntax-highlighting worker hasn't enqueued the larger file yet — body shows a skeleton"
      >
        <InteractiveDiffPanel
          diffs={[
            { fileKey: "small", diffText: SMALL_DIFF },
            { fileKey: "larger", diffText: LARGER_DIFF },
          ]}
          renderingFileKeys={new Set(["larger"])}
        />
      </StoryRow>
    </StoryCard>
  );
}
