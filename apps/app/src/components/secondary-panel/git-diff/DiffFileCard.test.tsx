// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginDiffRendererProps } from "@get-bb/plugin-sdk";
import type { DiffFileEntry } from "@bb/server-contract";
import type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "@/components/git-diff/GitDiffCardBody";
import type { DiffPatchState } from "@/hooks/queries/use-environment-diff-patches";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { DiffFileCard } from "./DiffFileCard";
import { makeDiffFileEntry } from "@/test/fixtures/diff-files";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

vi.mock("usehooks-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("usehooks-ts")>()),
  useIntersectionObserver: () => ({
    ref: () => {},
    isIntersecting: true,
    entry: undefined,
  }),
}));

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/Qo3AAAAAElFTkSuQmCC";

function buildEntry(overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return makeDiffFileEntry({
    additions: 1,
    deletions: 1,
    ...overrides,
  });
}

function renderCard({
  entry,
  onLoadPatch = vi.fn(),
  onRequestFileContents,
  patchState = { status: "idle" },
}: {
  entry: DiffFileEntry;
  onLoadPatch?: () => void;
  onRequestFileContents?: RequestDiffFileContents;
  patchState?: DiffPatchState;
}) {
  render(
    <DiffFileCard
      entry={entry}
      presentation={{
        view: "unified",
        overflow: "scroll",
        showLineNumbers: true,
      }}
      isCollapsed={false}
      onToggleCollapsed={() => {}}
      patchState={patchState}
      onLoadPatch={onLoadPatch}
      onRetry={() => {}}
      onRequestFileContents={onRequestFileContents}
    />,
  );
}

const TEXT_PATCH = [
  "diff --git a/src/file.ts b/src/file.ts",
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -1,2 +1,2 @@",
  "-const b = 2;",
  "+const b = 3;",
  "",
].join("\n");

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
});

describe("DiffFileCard", () => {
  it("previews on-demand binary images without loading the binary patch", async () => {
    const imageResult: DiffFileContentsResult = {
      kind: "image",
      dataUrl: IMAGE_DATA_URL,
      sizeBytes: 20_480,
    };
    const onLoadPatch = vi.fn();
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async () => imageResult,
    );

    renderCard({
      entry: buildEntry({
        path: "assets/logo.png",
        changeKind: "added",
        additions: 0,
        deletions: 0,
        binary: true,
        loadMode: "on_demand",
      }),
      onLoadPatch,
      onRequestFileContents,
    });

    const preview = await screen.findByRole("img", {
      name: "assets/logo.png",
    });

    expect(preview.getAttribute("src")).toBe(IMAGE_DATA_URL);
    expect(screen.queryByText("Load diff")).toBeNull();
    expect(onLoadPatch).not.toHaveBeenCalled();
    expect(onRequestFileContents).toHaveBeenCalledTimes(1);
    expect(onRequestFileContents).toHaveBeenCalledWith(
      "assets/logo.png",
      "new",
    );
  });

  it("keeps the load gate for non-image binary files", async () => {
    const onLoadPatch = vi.fn();
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(async () => ({
      kind: "image",
      dataUrl: IMAGE_DATA_URL,
      sizeBytes: 20_480,
    }));

    renderCard({
      entry: buildEntry({
        path: "assets/archive.bin",
        additions: 0,
        deletions: 0,
        binary: true,
        loadMode: "on_demand",
      }),
      onLoadPatch,
      onRequestFileContents,
    });

    await waitFor(() => {
      expect(screen.getByText("Binary file.")).toBeTruthy();
    });
    expect(screen.getByText("Load diff")).toBeTruthy();
    expect(onRequestFileContents).not.toHaveBeenCalled();
  });

  it("renders its text body through the shared host diff boundary", async () => {
    const seen: { patch: string; path: string; view: string }[] = [];
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        diffRenderers: [
          {
            id: "diffs",
            title: "Demo diffs",
            component: ({ patch, path, view }) => {
              seen.push({ patch, path, view });
              return <div data-testid="plugin-diff-body">plugin diff</div>;
            },
          },
        ],
      }),
    );

    renderCard({
      entry: buildEntry(),
      patchState: { status: "loaded", patch: TEXT_PATCH },
    });

    expect(await screen.findByTestId("plugin-diff-body")).toBeTruthy();
    expect(seen.at(-1)?.patch).toBe(TEXT_PATCH);
    expect(seen.at(-1)?.path).toBe("src/file.ts");
    expect(seen.at(-1)?.view).toBe("unified");
  });

  it("forwards lazily resolved text sides to a replacement renderer", async () => {
    const seen: PluginDiffRendererProps["experimental_fullFileContents"][] = [];
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        diffRenderers: [
          {
            id: "diffs",
            title: "Demo diffs",
            component: ({ experimental_fullFileContents }) => {
              seen.push(experimental_fullFileContents);
              return <div data-testid="plugin-diff-body">plugin diff</div>;
            },
          },
        ],
      }),
    );
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async (path, side) => ({
        kind: "text",
        file: {
          name: path,
          contents:
            side === "old"
              ? "const b = 2;\nconst tail = true;\n"
              : "const b = 3;\nconst tail = true;\n",
        },
      }),
    );

    renderCard({
      entry: buildEntry(),
      patchState: { status: "loaded", patch: TEXT_PATCH },
      onRequestFileContents,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand context" }),
    );
    await waitFor(() => {
      expect(seen.at(-1)).toEqual({
        old: {
          path: "src/file.ts",
          content: "const b = 2;\nconst tail = true;\n",
        },
        new: {
          path: "src/file.ts",
          content: "const b = 3;\nconst tail = true;\n",
        },
      });
    });
  });

  it("falls back to the load gate when an image-looking path is not previewable", async () => {
    const onLoadPatch = vi.fn();
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async () => null,
    );

    renderCard({
      entry: buildEntry({
        path: "assets/not-actually-image.png",
        additions: 0,
        deletions: 0,
        binary: true,
        loadMode: "on_demand",
      }),
      onLoadPatch,
      onRequestFileContents,
    });

    await waitFor(() => {
      expect(screen.getByText("Binary file.")).toBeTruthy();
    });
    expect(screen.getByText("Load diff")).toBeTruthy();
    expect(onRequestFileContents).toHaveBeenCalledTimes(2);
    expect(onLoadPatch).not.toHaveBeenCalled();
  });
});
