import type { TimelineFileChange } from "@bb/server-contract";
import { TimelineFileDiffBlock } from "./index";

export default {
  title: "Thread Timeline/TimelineFileDiffBlock",
};

const updateChange: TimelineFileChange = {
  path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
  kind: "update",
  movePath: null,
  diff: `diff --git a/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx b/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx
--- a/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx
+++ b/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx
@@ -12,7 +12,9 @@
-  return null;
+  return (
+    <TimelineRowsList rows={rows} />
+  );
`,
  diffStats: {
    added: 3,
    removed: 1,
  },
};

const createdChange: TimelineFileChange = {
  path: "apps/app/src/components/thread-timeline/replay-fixtures.stories.tsx",
  kind: "create",
  movePath: null,
  diff: "+export function FixtureReplay() {\n+  return <TimelineRowsStory rows={rows} />;\n+}\n",
  diffStats: {
    added: 3,
    removed: 0,
  },
};

const missingDiffChange: TimelineFileChange = {
  path: "apps/app/src/components/thread-timeline/empty.tsx",
  kind: "update",
  movePath: null,
  diff: null,
  diffStats: {
    added: 0,
    removed: 0,
  },
};

export function DiffStates() {
  return (
    <div className="flex max-w-5xl flex-col gap-4 bg-background p-6 text-foreground">
      <TimelineFileDiffBlock change={updateChange} themeType="light" />
      <TimelineFileDiffBlock change={createdChange} themeType="light" />
      <TimelineFileDiffBlock change={missingDiffChange} themeType="light" />
    </div>
  );
}

export function DarkThemeDiff() {
  return (
    <div className="max-w-5xl bg-background p-6 text-foreground">
      <TimelineFileDiffBlock change={updateChange} themeType="dark" />
    </div>
  );
}
