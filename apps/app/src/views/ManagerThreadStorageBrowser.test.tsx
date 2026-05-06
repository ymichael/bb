// @vitest-environment jsdom

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFile } from "@bb/server-contract";
import type { FilePreview } from "@/lib/file-preview";
import {
  MARKDOWN_PREVIEW_RENDER_MAX_CHARS,
  ManagerThreadStorageBrowser,
} from "./ManagerThreadStorageBrowser";

interface MakeTextPreviewArgs {
  content: string;
  mimeType?: string;
  path: string;
}

type SelectPathHandler = (path: string) => void;

interface RenderBrowserArgs {
  fileError?: Error | null;
  filePreview?: FilePreview;
  files?: readonly WorkspaceFile[];
  filesError?: Error | null;
  isFileLoading?: boolean;
  isFilesLoading?: boolean;
  onSelectPath?: SelectPathHandler;
  selectedPath?: string | null;
  truncated?: boolean;
}

interface TreeResetCall {
  initialExpandedPaths: readonly string[];
  paths: readonly string[];
}

type ClipboardWriteText = (text: string) => Promise<void>;

const treeResetCalls: TreeResetCall[] = vi.hoisted(() => []);

vi.mock("@pierre/trees/react", () => {
  interface MockUseFileTreeOptions {
    onSelectionChange?: (selectedPaths: readonly string[]) => void;
  }

  interface MockResetPathsOptions {
    initialExpandedPaths?: readonly string[];
  }

  interface MockFileTreeModel {
    readonly paths: readonly string[];
    getItem: (path: string) => MockFileTreeItemHandle | null;
    getSelectedPaths: () => readonly string[];
    resetPaths: (
      paths: readonly string[],
      options?: MockResetPathsOptions,
    ) => void;
    subscribe: (listener: () => void) => () => void;
  }

  interface MockFileTreeItemHandle {
    deselect: () => void;
    select: () => void;
  }

  interface MockFileTreeProps {
    "aria-label"?: string;
    className?: string;
    model: MockFileTreeModel;
    style?: CSSProperties;
  }

  function buildVisiblePaths(paths: readonly string[]): string[] {
    const visiblePaths: string[] = [];
    const seenPaths = new Set<string>();

    for (const path of paths) {
      const segments = path.split("/").filter((segment) => segment.length > 0);
      let directoryPath = "";
      for (const segment of segments.slice(0, -1)) {
        directoryPath = `${directoryPath}${segment}/`;
        if (!seenPaths.has(directoryPath)) {
          seenPaths.add(directoryPath);
          visiblePaths.push(directoryPath);
        }
      }
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        visiblePaths.push(path);
      }
    }

    return visiblePaths;
  }

  function createMockFileTreeModel(
    options: MockUseFileTreeOptions,
  ): MockFileTreeModel {
    let paths: readonly string[] = [];
    let selectedPaths: readonly string[] = [];
    const listeners = new Set<() => void>();
    const emit = () => {
      for (const listener of listeners) {
        listener();
      }
    };

    return {
      get paths() {
        return paths;
      },
      getItem(path) {
        if (!paths.includes(path)) {
          return null;
        }
        return {
          deselect() {
            selectedPaths = selectedPaths.filter(
              (selectedPath) => selectedPath !== path,
            );
            emit();
          },
          select() {
            selectedPaths = [path];
            options.onSelectionChange?.(selectedPaths);
            emit();
          },
        };
      },
      getSelectedPaths() {
        return selectedPaths;
      },
      resetPaths(nextPaths, options) {
        paths = [...nextPaths];
        treeResetCalls.push({
          initialExpandedPaths: [...(options?.initialExpandedPaths ?? [])],
          paths: [...nextPaths],
        });
        emit();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }

  function useFileTree(options: MockUseFileTreeOptions) {
    const modelRef = useRef<MockFileTreeModel | null>(null);
    if (!modelRef.current) {
      modelRef.current = createMockFileTreeModel(options);
    }
    return { model: modelRef.current };
  }

  function FileTree({
    "aria-label": ariaLabel,
    className,
    model,
    style,
  }: MockFileTreeProps) {
    const [, setVersion] = useState(0);

    useEffect(
      () => model.subscribe(() => setVersion((version) => version + 1)),
      [model],
    );

    return (
      <div
        aria-label={ariaLabel}
        className={className}
        role="tree"
        style={style}
      >
        {buildVisiblePaths(model.paths).map((path) => (
          <button
            key={path}
            type="button"
            role="treeitem"
            onClick={() => model.getItem(path)?.select()}
          >
            {path}
          </button>
        ))}
      </div>
    );
  }

  return { FileTree, useFileTree };
});

function makeFiles(paths: readonly string[]): WorkspaceFile[] {
  return paths.map((path) => ({
    name: path.split("/").at(-1) ?? path,
    path,
  }));
}

function makeTextPreview(args: MakeTextPreviewArgs): FilePreview {
  return {
    content: args.content,
    kind: "text",
    mimeType: args.mimeType ?? "text/plain",
    name: args.path.split("/").at(-1) ?? args.path,
    path: args.path,
    url: `/preview/${encodeURIComponent(args.path)}`,
  };
}

function renderBrowser(args: RenderBrowserArgs) {
  return render(
    <ManagerThreadStorageBrowser
      fileError={args.fileError ?? null}
      filePreview={args.filePreview}
      files={args.files}
      filesError={args.filesError ?? null}
      isFileLoading={args.isFileLoading ?? false}
      isFilesLoading={args.isFilesLoading ?? false}
      onSelectPath={args.onSelectPath ?? (() => {})}
      selectedPath={args.selectedPath ?? null}
      truncated={args.truncated ?? false}
    />,
  );
}

function installClipboardWriteTextMock() {
  const writeText = vi.fn<ClipboardWriteText>();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  treeResetCalls.length = 0;
  vi.clearAllMocks();
});

describe("ManagerThreadStorageBrowser", () => {
  it("renders nested tree paths and selects files", async () => {
    const onSelectPath = vi.fn();
    renderBrowser({
      filePreview: makeTextPreview({
        content: "Guide",
        path: "docs/guide.md",
      }),
      files: makeFiles(["README.md", "docs/guide.md", "docs/reports/q1.md"]),
      onSelectPath,
      selectedPath: "docs/guide.md",
    });

    expect(await screen.findByRole("treeitem", { name: "docs/" })).toBeTruthy();
    expect(
      screen.getByRole("treeitem", { name: "docs/reports/" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("treeitem", { name: "docs/reports/q1.md" }),
    );

    expect(onSelectPath).toHaveBeenCalledWith("docs/reports/q1.md");
  });

  it("resets the tree with file paths and derived directory expansion", async () => {
    renderBrowser({
      files: makeFiles(["README.md", "docs/guide.md", "docs/reports/q1.md"]),
      selectedPath: "docs/guide.md",
    });

    expect(await screen.findByRole("treeitem", { name: "docs/" })).toBeTruthy();

    expect(treeResetCalls.at(-1)).toEqual({
      initialExpandedPaths: ["docs/", "docs/reports/"],
      paths: ["README.md", "docs/guide.md", "docs/reports/q1.md"],
    });
  });

  it("syncs the shadow-root tree color-scheme with the document theme", async () => {
    renderBrowser({
      files: makeFiles(["README.md"]),
      selectedPath: null,
    });

    const tree = await screen.findByRole("tree", {
      name: "Thread storage file tree",
    });

    expect(tree.style.getPropertyValue("color-scheme")).toBe("light");

    document.documentElement.classList.add("dark");

    await waitFor(() => {
      expect(tree.style.getPropertyValue("color-scheme")).toBe("dark");
    });
  });

  it("copies the selected relative path", async () => {
    const writeText = installClipboardWriteTextMock();
    renderBrowser({
      filePreview: makeTextPreview({
        content: "Guide",
        path: "docs/guide.md",
      }),
      files: makeFiles(["docs/guide.md"]),
      selectedPath: "docs/guide.md",
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy relative path" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("docs/guide.md");
    });
  });

  it("renders Markdown previews without raw HTML DOM", () => {
    const { container } = renderBrowser({
      filePreview: makeTextPreview({
        content: "# Plan\n\n<script>alert('x')</script>",
        mimeType: "text/markdown",
        path: "docs/plan.md",
      }),
      files: makeFiles(["docs/plan.md"]),
      selectedPath: "docs/plan.md",
    });

    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert('x')</script>");
  });

  it("falls back for Markdown above the render threshold", () => {
    renderBrowser({
      filePreview: makeTextPreview({
        content: "#".repeat(MARKDOWN_PREVIEW_RENDER_MAX_CHARS + 1),
        mimeType: "text/markdown",
        path: "docs/huge.md",
      }),
      files: makeFiles(["docs/huge.md"]),
      selectedPath: "docs/huge.md",
    });

    expect(screen.getByText(/Markdown rendering is disabled/u)).toBeTruthy();
    expect(screen.getByLabelText("Markdown source")).toBeTruthy();
  });

  it("truncates large non-Markdown source previews", () => {
    renderBrowser({
      filePreview: makeTextPreview({
        content: "a".repeat(200_001),
        mimeType: "text/plain",
        path: "logs/output.txt",
      }),
      files: makeFiles(["logs/output.txt"]),
      selectedPath: "logs/output.txt",
    });

    expect(
      screen.getByText("Showing the first 200,000 characters as source."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Source").textContent?.length).toBe(200_000);
  });

  it("renders image, unsupported, empty, and error preview states", () => {
    const view = renderBrowser({
      filePreview: {
        kind: "image",
        mimeType: "image/png",
        path: "images/diagram.png",
        url: "/preview/diagram.png",
      },
      files: makeFiles(["images/diagram.png"]),
      selectedPath: "images/diagram.png",
    });

    expect(
      screen.getByRole("img", { name: "images/diagram.png" }),
    ).toBeTruthy();

    view.rerender(
      <ManagerThreadStorageBrowser
        filePreview={{
          kind: "unsupported",
          mimeType: "application/octet-stream",
          path: "archive.bin",
          url: "/preview/archive.bin",
        }}
        files={makeFiles(["archive.bin"])}
        filesError={null}
        fileError={null}
        isFileLoading={false}
        isFilesLoading={false}
        onSelectPath={() => {}}
        selectedPath="archive.bin"
        truncated={false}
      />,
    );
    expect(
      screen.getByText("Preview not available for application/octet-stream."),
    ).toBeTruthy();

    view.rerender(
      <ManagerThreadStorageBrowser
        filePreview={makeTextPreview({ content: "", path: "empty.txt" })}
        files={makeFiles(["empty.txt"])}
        filesError={null}
        fileError={null}
        isFileLoading={false}
        isFilesLoading={false}
        onSelectPath={() => {}}
        selectedPath="empty.txt"
        truncated={false}
      />,
    );
    expect(screen.getByText("Empty file.")).toBeTruthy();

    view.rerender(
      <ManagerThreadStorageBrowser
        files={makeFiles(["broken.txt"])}
        filesError={null}
        fileError={new Error("Preview failed")}
        isFileLoading={false}
        isFilesLoading={false}
        onSelectPath={() => {}}
        selectedPath="broken.txt"
        truncated={false}
      />,
    );
    expect(screen.getByText("Preview failed")).toBeTruthy();
  });

  it("renders empty, list error, and truncation states", () => {
    const view = renderBrowser({
      files: [],
      selectedPath: null,
    });
    expect(screen.getByText("No files yet.")).toBeTruthy();

    view.rerender(
      <ManagerThreadStorageBrowser
        filesError={new Error("List failed")}
        fileError={null}
        isFileLoading={false}
        isFilesLoading={false}
        onSelectPath={() => {}}
        selectedPath={null}
        truncated={false}
      />,
    );
    expect(screen.getByText("List failed")).toBeTruthy();

    view.rerender(
      <ManagerThreadStorageBrowser
        files={makeFiles(["README.md"])}
        filesError={null}
        fileError={null}
        filePreview={makeTextPreview({ content: "Readme", path: "README.md" })}
        isFileLoading={false}
        isFilesLoading={false}
        onSelectPath={() => {}}
        selectedPath="README.md"
        truncated={true}
      />,
    );
    expect(screen.getByText(/File list truncated at 1 file/u)).toBeTruthy();
  });

  it("filters loaded paths with local search", async () => {
    renderBrowser({
      files: makeFiles(["docs/guide.md", "reports/q1.md"]),
      selectedPath: "docs/guide.md",
    });

    fireEvent.change(screen.getByLabelText("Search storage files"), {
      target: { value: "reports" },
    });

    expect(
      await screen.findByRole("treeitem", { name: "reports/q1.md" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("treeitem", { name: "docs/guide.md" }),
    ).toBeNull();
  });
});
