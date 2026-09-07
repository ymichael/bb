// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFileEntry } from "@bb/server-contract";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "@/components/git-diff/GitDiffCardBody";
import { DiffFileCard } from "./DiffFileCard";
import { makeDiffFileEntry } from "@/test/fixtures/diff-files";

const diffViewMock = vi.hoisted(() => ({
  renderedFileDiffs: [] as unknown[],
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: unknown }) => {
    diffViewMock.renderedFileDiffs.push(fileDiff);
    return <div data-testid="diff-view" />;
  },
}));

const DIFF_RENDERER_CHUNK_TIMEOUT_MS = 10_000;

function findDiffView() {
  return screen.findByTestId(
    "diff-view",
    {},
    { timeout: DIFF_RENDERER_CHUNK_TIMEOUT_MS },
  );
}

const MODIFIED_PATCH = [
  "diff --git a/src/file.ts b/src/file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -2,3 +2,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "",
].join("\n");

const OLD_FILE_CONTENTS = [
  "// header",
  "const a = 1;",
  "const b = 2;",
  "const c = 4;",
  "// footer",
  "",
].join("\n");
const NEW_FILE_CONTENTS = OLD_FILE_CONTENTS.replace(
  "const b = 2;",
  "const b = 3;",
);

const ADDED_PATCH = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..2222222",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+const a = 1;",
  "+const b = 2;",
  "",
].join("\n");

function buildEntry(overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return makeDiffFileEntry({
    additions: 1,
    deletions: 1,
    ...overrides,
  });
}

function textResult(contents: string, name: string): DiffFileContentsResult {
  return { kind: "text", file: { name, contents } };
}

const intersectionCallbacks = new Set<IntersectionObserverCallback>();

function revealCardBodies() {
  act(() => {
    for (const callback of intersectionCallbacks) {
      callback(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        { thresholds: [0] } as unknown as IntersectionObserver,
      );
    }
  });
}

function stubPointer(kind: "coarse" | "fine") {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: kind === "coarse" && query === POINTER_COARSE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderModifiedCard(onRequestFileContents: RequestDiffFileContents) {
  render(
    <DiffFileCard
      entry={buildEntry()}
      presentation={{
        view: "unified",
        overflow: "scroll",
        showLineNumbers: true,
      }}
      isCollapsed={false}
      onToggleCollapsed={() => {}}
      patchState={{ status: "loaded", patch: MODIFIED_PATCH, truncated: false }}
      onLoadPatch={() => {}}
      onRetry={() => {}}
      onRequestFileContents={onRequestFileContents}
    />,
  );
}

describe("DiffFileCard context expansion", () => {
  beforeEach(() => {
    diffViewMock.renderedFileDiffs.length = 0;
    intersectionCallbacks.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class IntersectionObserverMock {
        readonly thresholds = [0];
        constructor(private readonly callback: IntersectionObserverCallback) {
          intersectionCallbacks.add(this.callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {
          intersectionCallbacks.delete(this.callback);
        }
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a modified text diff from the patch alone on coarse pointers and fetches contents only on demand", async () => {
    stubPointer("coarse");
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async (path, side) =>
        textResult(
          side === "old" ? OLD_FILE_CONTENTS : NEW_FILE_CONTENTS,
          path,
        ),
    );

    renderModifiedCard(onRequestFileContents);
    revealCardBodies();

    await findDiffView();
    const expandButton = await screen.findByRole("button", {
      name: "Expand context",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onRequestFileContents).not.toHaveBeenCalled();
    const patchOnlyRenderCount = diffViewMock.renderedFileDiffs.length;
    expect(patchOnlyRenderCount).toBeGreaterThan(0);

    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(onRequestFileContents).toHaveBeenCalledTimes(2);
    });
    expect(onRequestFileContents).toHaveBeenCalledWith("src/file.ts", "old");
    expect(onRequestFileContents).toHaveBeenCalledWith("src/file.ts", "new");
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Expand context" }),
      ).toBeNull();
    });
    const lastRenderedFileDiff = diffViewMock.renderedFileDiffs.at(-1);
    expect(lastRenderedFileDiff).not.toBe(diffViewMock.renderedFileDiffs[0]);
  });

  it("requests the contents during idle time on fine pointers without an explicit action", async () => {
    stubPointer("fine");
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async (path, side) =>
        textResult(
          side === "old" ? OLD_FILE_CONTENTS : NEW_FILE_CONTENTS,
          path,
        ),
    );

    renderModifiedCard(onRequestFileContents);
    revealCardBodies();

    await waitFor(() => {
      expect(onRequestFileContents).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("button", { name: "Expand context" })).toBeNull();
  });

  it("offers a retry when the context fetch fails", async () => {
    stubPointer("coarse");
    let shouldFail = true;
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async (path, side) => {
        if (shouldFail) {
          throw new Error("offline");
        }
        return textResult(
          side === "old" ? OLD_FILE_CONTENTS : NEW_FILE_CONTENTS,
          path,
        );
      },
    );

    renderModifiedCard(onRequestFileContents);
    revealCardBodies();

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand context" }),
    );
    const retryButton = await screen.findByRole("button", { name: "Retry" });
    expect(onRequestFileContents).toHaveBeenCalledTimes(2);

    shouldFail = false;
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(onRequestFileContents).toHaveBeenCalledTimes(4);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  it("never fetches contents for an added file, whose patch already carries every line", async () => {
    stubPointer("fine");
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(async (path) =>
      textResult("const a = 1;\nconst b = 2;\n", path),
    );

    render(
      <DiffFileCard
        entry={buildEntry({
          path: "src/new.ts",
          changeKind: "added",
          additions: 2,
          deletions: 0,
        })}
        presentation={{
          view: "unified",
          overflow: "scroll",
          showLineNumbers: true,
        }}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        patchState={{ status: "loaded", patch: ADDED_PATCH, truncated: false }}
        onLoadPatch={() => {}}
        onRetry={() => {}}
        onRequestFileContents={onRequestFileContents}
      />,
    );
    revealCardBodies();

    await findDiffView();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onRequestFileContents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Expand context" })).toBeNull();
  });
});
