import { useCallback, useState } from "react";
import type { DiffFileEntry } from "@bb/server-contract";
import type { DiffPresentation } from "@/components/code/code-rendering";
import type { RequestDiffFileContents } from "@/components/git-diff/GitDiffCardBody";
import { DEFAULT_CODE_OVERFLOW_MODE } from "@/lib/code-overflow-mode";
import type { DiffPatchState } from "@/hooks/queries/use-environment-diff-patches";
import { appToast } from "@/components/ui/app-toast";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { DiffFileCard } from "./DiffFileCard";
import { makeDiffFileEntry } from "@/test/fixtures/diff-files";

export default {
  title: "right-panel/Diff File Card",
};

const MODIFIED_PATCH = [
  "diff --git a/src/file.ts b/src/file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

const TALL_ADDED_LINES = 40;

const TALL_PATCH = [
  "diff --git a/src/tall.ts b/src/tall.ts",
  "index 1111111..2222222 100644",
  "--- a/src/tall.ts",
  "+++ b/src/tall.ts",
  `@@ -1,2 +1,${TALL_ADDED_LINES + 2} @@`,
  " export const start = true;",
  ...Array.from(
    { length: TALL_ADDED_LINES },
    (_, index) => `+export const line${index + 1} = ${index + 1};`,
  ),
  " export const end = true;",
  "",
].join("\n");

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/Qo3AAAAAElFTkSuQmCC";

const imageContentsRequester: RequestDiffFileContents = async () => ({
  kind: "image",
  dataUrl: IMAGE_DATA_URL,
  sizeBytes: 20_480,
});

const CONTEXT_FILE_LINES = Array.from(
  { length: 24 },
  (_, index) => `export const line${index + 1} = ${index + 1};`,
);
const CONTEXT_OLD_FILE = `${CONTEXT_FILE_LINES.join("\n")}\n`;
const CONTEXT_NEW_FILE = CONTEXT_OLD_FILE.replace(
  "export const line12 = 12;",
  "export const line12 = 1200;",
);
const CONTEXT_PATCH = [
  "diff --git a/src/context.ts b/src/context.ts",
  "index 1111111..2222222 100644",
  "--- a/src/context.ts",
  "+++ b/src/context.ts",
  "@@ -11,3 +11,3 @@",
  " export const line11 = 11;",
  "-export const line12 = 12;",
  "+export const line12 = 1200;",
  " export const line13 = 13;",
  "",
].join("\n");

const contextContentsRequester: RequestDiffFileContents = async (
  path,
  side,
) => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return {
    kind: "text",
    file: {
      name: path,
      contents: side === "old" ? CONTEXT_OLD_FILE : CONTEXT_NEW_FILE,
    },
  };
};

function buildEntry(overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return makeDiffFileEntry({
    additions: 1,
    deletions: 1,
    ...overrides,
  });
}

interface CardStageProps {
  entry?: Partial<DiffFileEntry>;
  patchState?: DiffPatchState;
  collapsed?: boolean;
  onRequestFileContents?: RequestDiffFileContents;
}

const CARD_PRESENTATION: DiffPresentation = {
  view: "unified",
  overflow: DEFAULT_CODE_OVERFLOW_MODE,
  showLineNumbers: true,
};

function CardStage({
  entry,
  patchState = { status: "idle" },
  collapsed = false,
  onRequestFileContents,
}: CardStageProps) {
  const [isCollapsed, setIsCollapsed] = useState(collapsed);
  const toast = useCallback(
    (label: string) => (path: string) =>
      appToast.message(label, { description: path }),
    [],
  );
  return (
    <div className="w-full max-w-[640px] min-w-0">
      <DiffFileCard
        entry={buildEntry(entry)}
        presentation={CARD_PRESENTATION}
        isCollapsed={isCollapsed}
        onToggleCollapsed={() => setIsCollapsed((value) => !value)}
        patchState={patchState}
        onLoadPatch={() => appToast.message("Load diff requested")}
        onRetry={() => appToast.message("Retry requested")}
        onOpenFileInEditor={toast("Open in editor")}
        onOpenFilePreview={toast("Open file preview")}
        onRequestFileContents={onRequestFileContents}
      />
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="loaded · modified"
        hint="an auto-tier file whose patch has arrived; renders the real unified diff"
      >
        <CardStage
          patchState={{
            status: "loaded",
            patch: MODIFIED_PATCH,
            truncated: false,
          }}
        />
      </StoryRow>
      <StoryRow
        label="expand context on demand"
        hint="text card with a contents fetcher: on a fine pointer the full file loads during idle time and pierre's gap buttons appear; on touch the card renders from the patch and offers Expand context under the diff"
      >
        <CardStage
          entry={{ path: "src/context.ts" }}
          patchState={{
            status: "loaded",
            patch: CONTEXT_PATCH,
            truncated: false,
          }}
          onRequestFileContents={contextContentsRequester}
        />
      </StoryRow>
      <StoryRow
        label="load on demand"
        hint="on_demand tier (large or binary): header + a Load diff CTA that triggers the fetch"
      >
        <CardStage
          entry={{ loadMode: "on_demand", additions: 820, deletions: 140 }}
        />
      </StoryRow>
      <StoryRow
        label="too large"
        hint="too_large tier: never fetched; a notice plus an open-in-preview link"
      >
        <CardStage
          entry={{ loadMode: "too_large", additions: 30_000, deletions: 0 }}
        />
      </StoryRow>
      <StoryRow
        label="truncated patch"
        hint="loaded but tail-cut past the byte budget; offers a Show full diff affordance"
      >
        <CardStage
          patchState={{
            status: "loaded",
            patch: MODIFIED_PATCH,
            truncated: true,
          }}
        />
      </StoryRow>
      <StoryRow
        label="per-file error"
        hint="a failed patch fetch surfaces the message inline with a Retry"
      >
        <CardStage
          patchState={{ status: "error", error: "Request timed out after 10s" }}
        />
      </StoryRow>
      <StoryRow
        label="loading"
        hint="auto-tier patch in flight; a skeleton holds the space"
      >
        <CardStage patchState={{ status: "loading" }} />
      </StoryRow>
      <StoryRow
        label="no renderable diff"
        hint="a loaded patch that parses to nothing (pure rename / mode-only) is terminal, not a spinner"
      >
        <CardStage
          patchState={{ status: "loaded", patch: "", truncated: false }}
        />
      </StoryRow>
      <StoryRow
        label="image change"
        hint="an on_demand binary image previews directly from file bytes without first loading a binary patch"
      >
        <CardStage
          entry={{
            path: "assets/logo.png",
            changeKind: "added",
            additions: 0,
            deletions: 0,
            binary: true,
            loadMode: "on_demand",
          }}
          onRequestFileContents={imageContentsRequester}
        />
      </StoryRow>
      <StoryRow
        label="collapsed"
        hint="header only; click the chevron to expand the body"
      >
        <CardStage
          collapsed
          patchState={{
            status: "loaded",
            patch: MODIFIED_PATCH,
            truncated: false,
          }}
        />
      </StoryRow>
    </StoryCard>
  );
}

export function StickyHeader() {
  return (
    <StoryCard>
      <StoryRow
        label="sticky header on scroll"
        hint="scroll the panel: each file header pins to the top, squares its top corners while stuck, and clips to the card's rounded shape so corners never peek over the scrolling diff"
      >
        <div
          className="w-full max-w-[640px] min-w-0 space-y-2 overflow-auto rounded-md border border-border bg-background px-4 py-3"
          style={{ maxHeight: 320 }}
        >
          <CardStage
            entry={{ path: "src/first.ts" }}
            patchState={{
              status: "loaded",
              patch: TALL_PATCH,
              truncated: false,
            }}
          />
          <CardStage
            entry={{ path: "src/second.ts" }}
            patchState={{
              status: "loaded",
              patch: TALL_PATCH,
              truncated: false,
            }}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}
