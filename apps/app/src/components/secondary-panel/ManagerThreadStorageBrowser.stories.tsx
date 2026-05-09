import { useMemo, useState, type ReactNode } from "react";
import type { WorkspaceFile } from "@bb/server-contract";
import { ManagerThreadStorageBrowser } from "./ManagerThreadStorageBrowser";
import type { FilePreview } from "@/lib/file-preview";

export default {
  title: "secondary-panel/Workspace",
};

function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="m-6 h-[640px] w-full max-w-[760px] min-w-0 overflow-hidden rounded-md border border-border/70 bg-background p-4">
      {children}
    </div>
  );
}

function makeFile(path: string): WorkspaceFile {
  const segments = path.split("/");
  return { path, name: segments[segments.length - 1] ?? path };
}

const files: WorkspaceFile[] = [
  makeFile("ASYNC.md"),
  makeFile("STATUS.md"),
  makeFile("PREFERENCES.md"),
];

const previews: Record<string, FilePreview> = {
  "ASYNC.md": {
    kind: "text",
    path: "ASYNC.md",
    name: "ASYNC.md",
    url: "memory://ASYNC.md",
    mimeType: "text/markdown",
    content: `# Async work in flight

## Pull requests
- **#1284 — Sidebar: project rail + spacing pass.** Awaiting review from @michael. CI green.
- **#1276 — Secondary panel: extract ThreadMetadataContent.** Merged earlier today; backport to release/2026-04 still pending.

## Investigations
- **Codex provider auth path.** Logs at \`~/.bb-dev/logs/host-daemon.log\` show the renewal token race after laptop sleep. Repro is reliable; fix sketch in plans/codex-auth-renewal.md.
- **Slow tests on macOS GitHub runners.** Suspect: the timeline pagination v2 merge. Trying \`vitest run --shard=1/4\` to bisect.

## Follow-ups
- Once #1284 lands, drop the \`promotedBranchName\` plumbing from \`ProjectList.tsx\`.
- Reply to design feedback on the env summary banner truncation rules.
`,
  },
  "STATUS.md": {
    kind: "text",
    path: "STATUS.md",
    name: "STATUS.md",
    url: "memory://STATUS.md",
    mimeType: "text/markdown",
    content: `# Manager status

**Mode:** triaging follow-ups before standup.

## What's done
- Sidebar consolidation merged
- Realistic story fixtures landed for sidebar/Projects, sidebar/Threads
- ThreadMetadataContent refactor: stories + production both go through the same derivation

## In progress
- Workspace tab story polish (this thread)
- Diff toolbar extraction — needs review before opening a PR

## Blocked
- Nothing today.
`,
  },
  "PREFERENCES.md": {
    kind: "text",
    path: "PREFERENCES.md",
    name: "PREFERENCES.md",
    url: "memory://PREFERENCES.md",
    mimeType: "text/markdown",
    content: `# Working preferences (manager → children)

- **Tone:** terse. No trailing summaries. State decisions, not the deliberation behind them.
- **Reuse:** check for an existing helper before adding a new one. If a pattern repeats N times, extract it.
- **Tests:** test outcomes (state, return values, persisted data), never call sequences. Real DB, no mocks of our own code.
- **Commits:** group refactors with the behavior change they enable. Don't split for the sake of splitting.
- **Stories:** if production derives a value, the story should derive it through the same code path. No fabricated colors or labels.
`,
  },
};

export function Overview() {
  const [selectedPath, setSelectedPath] = useState<string | null>("ASYNC.md");
  const filePreview = useMemo(
    () => (selectedPath ? previews[selectedPath] : undefined),
    [selectedPath],
  );

  return (
    <PanelStage>
      <ManagerThreadStorageBrowser
        files={files}
        filesError={null}
        isFilesLoading={false}
        filePreview={filePreview}
        fileError={null}
        isFileLoading={false}
        onSelectPath={setSelectedPath}
        selectedPath={selectedPath}
        truncated={false}
      />
    </PanelStage>
  );
}
