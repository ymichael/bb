import type { TimelineViewWorkRow } from "@bb/thread-view";
import {
  commandRow,
  fileChangeRow,
  toolRow,
} from "@/test/fixtures/thread-timeline-rows";
import { WorkRowBody } from "./TimelineRowDetails.js";

export default {
  title: "Thread Timeline/TimelineRowDetails",
};

interface WorkRowStoryCase {
  id: string;
  label: string;
  row: TimelineViewWorkRow;
}

const workRows: readonly WorkRowStoryCase[] = [
  {
    id: "command",
    label: "Command output",
    row: commandRow({
      id: "detail-command-1",
      command: "pnpm exec turbo run typecheck --filter=@bb/app",
      output: "typecheck passed\n",
      seq: 1,
    }),
  },
  {
    id: "tool",
    label: "Tool call",
    row: toolRow({
      id: "detail-tool-1",
      toolName: "Read",
      label:
        "Read apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
      toolArgs: {
        file_path:
          "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
      },
      output: "export function ThreadTimelineRows() { ... }",
      seq: 2,
    }),
  },
  {
    id: "file-change",
    label: "File change with stderr",
    row: fileChangeRow({
      id: "detail-file-change-1",
      path: "apps/app/src/components/thread-timeline/TimelineRowDetails.tsx",
      diff: "@@ -1 +1 @@\n-old body\n+new body\n",
      diffStats: {
        added: 1,
        removed: 1,
      },
      stderr: "warning: formatter adjusted trailing whitespace",
      seq: 3,
    }),
  },
];

export function DetailBodies() {
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-4 bg-background p-6 text-foreground lg:grid-cols-3">
      {workRows.map((storyCase) => (
        <section
          key={storyCase.id}
          className="min-w-0 rounded-md border border-border/70 p-3"
        >
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {storyCase.label}
          </div>
          <WorkRowBody row={storyCase.row} themeType="light" />
        </section>
      ))}
    </div>
  );
}
