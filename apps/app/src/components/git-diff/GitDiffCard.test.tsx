// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FileContents } from "@pierre/diffs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitDiffCard, type RequestDiffFileContents } from "./GitDiffCard";
import { parseGitDiffFiles } from "./git-diff-parsing";

interface MockFileDiffProps {
  fileDiff: MockFileDiff;
}

interface MockFileDiff {
  oldLines?: string[];
  newLines?: string[];
}

interface RequestedDiffFileContent {
  path: string;
  side: "old" | "new";
}

interface DeferredDiffFileContentRequest extends RequestedDiffFileContent {
  resolve: (file: FileContents | null) => void;
}

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: MockFileDiffProps) => (
    <div
      data-testid="diff-view"
      data-old-lines={fileDiff.oldLines?.length ?? "missing"}
      data-new-lines={fileDiff.newLines?.length ?? "missing"}
    >
      Rendered diff
    </div>
  ),
}));

vi.mock("usehooks-ts", () => ({
  useIntersectionObserver: () => ({
    ref: () => {},
    isIntersecting: true,
  }),
}));

const NEW_FILE_DIFF = [
  "diff --git a/src/new-file.ts b/src/new-file.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/new-file.ts",
  "@@ -0,0 +1 @@",
  "+export const value = 1;",
  "",
].join("\n");

const DELETED_FILE_DIFF = [
  "diff --git a/src/deleted-file.ts b/src/deleted-file.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/src/deleted-file.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const value = 1;",
  "",
].join("\n");

const MODIFIED_FILE_DIFF = [
  "diff --git a/src/modified-file.ts b/src/modified-file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/modified-file.ts",
  "+++ b/src/modified-file.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

afterEach(() => {
  cleanup();
});

describe("GitDiffCard", () => {
  it("gates deleted file rendering and content loading behind an explicit load action", async () => {
    const deletedFile = parseGitDiffFiles(DELETED_FILE_DIFF)[0];
    expect(deletedFile).toBeDefined();
    if (!deletedFile) return;
    const requests: RequestedDiffFileContent[] = [];
    const requestFileContents: RequestDiffFileContents = async (path, side) => {
      requests.push({ path, side });
      return {
        contents: "export const value = 1;\n",
        name: path,
      };
    };

    render(
      <GitDiffCard
        fileDiff={deletedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    expect(screen.queryByText("Deleted")).toBeNull();
    expect(screen.getByText("This file was deleted.")).toBeTruthy();
    expect(screen.queryByTestId("diff-view")).toBeNull();
    expect(requests).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));

    expect(screen.getByTestId("diff-view")).toBeTruthy();
    await waitFor(() => {
      expect(requests).toEqual([
        { path: "src/deleted-file.ts", side: "old" },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("diff-view").getAttribute("data-old-lines"),
      ).toBe("1");
    });
    expect(screen.getByTestId("diff-view").getAttribute("data-new-lines")).toBe(
      "0",
    );
  });

  it("shows only the relevant sign for added and deleted file stats", () => {
    const addedFile = parseGitDiffFiles(NEW_FILE_DIFF)[0];
    expect(addedFile).toBeDefined();
    if (!addedFile) return;

    render(
      <GitDiffCard
        fileDiff={addedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
      />,
    );

    expect(screen.queryByText("Added")).toBeNull();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByText("-0")).toBeNull();

    cleanup();

    const deletedFile = parseGitDiffFiles(DELETED_FILE_DIFF)[0];
    expect(deletedFile).toBeDefined();
    if (!deletedFile) return;

    render(
      <GitDiffCard
        fileDiff={deletedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
      />,
    );

    expect(screen.queryByText("Deleted")).toBeNull();
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("does not fetch the missing side for added files", async () => {
    const addedFile = parseGitDiffFiles(NEW_FILE_DIFF)[0];
    expect(addedFile).toBeDefined();
    if (!addedFile) return;
    const requests: RequestedDiffFileContent[] = [];
    const requestFileContents: RequestDiffFileContents = async (path, side) => {
      requests.push({ path, side });
      return {
        contents: "export const value = 1;\n",
        name: path,
      };
    };

    render(
      <GitDiffCard
        fileDiff={addedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    await waitFor(() => {
      expect(requests).toEqual([{ path: "src/new-file.ts", side: "new" }]);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("diff-view").getAttribute("data-old-lines"),
      ).toBe("0");
    });
    expect(screen.getByTestId("diff-view").getAttribute("data-new-lines")).toBe(
      "1",
    );
  });

  it("marks null content as unavailable without retrying until the file changes", async () => {
    const modifiedFile = parseGitDiffFiles(MODIFIED_FILE_DIFF)[0];
    expect(modifiedFile).toBeDefined();
    if (!modifiedFile) return;
    const requests: RequestedDiffFileContent[] = [];
    const requestFileContents: RequestDiffFileContents = async (path, side) => {
      requests.push({ path, side });
      return null;
    };

    const { rerender } = render(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    await waitFor(() => {
      expect(requests).toEqual([
        { path: "src/modified-file.ts", side: "old" },
        { path: "src/modified-file.ts", side: "new" },
      ]);
    });

    rerender(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    expect(requests).toHaveLength(2);
  });

  it("handles rejected content requests without retrying until the file changes", async () => {
    const modifiedFile = parseGitDiffFiles(MODIFIED_FILE_DIFF)[0];
    expect(modifiedFile).toBeDefined();
    if (!modifiedFile) return;
    const requests: RequestedDiffFileContent[] = [];
    const requestFileContents: RequestDiffFileContents = (path, side) => {
      requests.push({ path, side });
      return Promise.reject(new Error("Cannot read file"));
    };

    const { rerender } = render(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    await waitFor(() => {
      expect(requests).toEqual([
        { path: "src/modified-file.ts", side: "old" },
        { path: "src/modified-file.ts", side: "new" },
      ]);
    });

    rerender(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    expect(requests).toHaveLength(2);
  });

  it("retries cancelled in-flight content loading when the card becomes renderable again", async () => {
    const modifiedFile = parseGitDiffFiles(MODIFIED_FILE_DIFF)[0];
    expect(modifiedFile).toBeDefined();
    if (!modifiedFile) return;
    const requests: DeferredDiffFileContentRequest[] = [];
    const requestFileContents: RequestDiffFileContents = (path, side) =>
      new Promise<FileContents | null>((resolve) => {
        requests.push({ path, side, resolve });
      });

    const { rerender } = render(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });

    rerender(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering
        onRequestFileContents={requestFileContents}
      />,
    );
    rerender(
      <GitDiffCard
        fileDiff={modifiedFile}
        diffViewOptions={{}}
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isRendering={false}
        onRequestFileContents={requestFileContents}
      />,
    );

    await waitFor(() => {
      expect(requests).toHaveLength(4);
    });
    expect(requests.map(({ path, side }) => ({ path, side }))).toEqual([
      { path: "src/modified-file.ts", side: "old" },
      { path: "src/modified-file.ts", side: "new" },
      { path: "src/modified-file.ts", side: "old" },
      { path: "src/modified-file.ts", side: "new" },
    ]);

    await act(async () => {
      requests[2]?.resolve({
        contents: "export const value = 1;\n",
        name: "src/modified-file.ts",
      });
      requests[3]?.resolve({
        contents: "export const value = 2;\n",
        name: "src/modified-file.ts",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("diff-view").getAttribute("data-old-lines"),
      ).toBe("1");
    });
    expect(screen.getByTestId("diff-view").getAttribute("data-new-lines")).toBe(
      "1",
    );
  });
});
