// @vitest-environment jsdom

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFile } from "@bb/server-contract";
import { setPreferredTheme } from "@/hooks/useTheme";
import { ManagerThreadStorageBrowser } from "./ManagerThreadStorageBrowser";
import { useManagerStorageBrowser } from "./useManagerStorageBrowser";

interface TreeResetCall {
  initialExpandedPaths: readonly string[];
  paths: readonly string[];
}

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

function Harness({
  files,
  filesError,
  isFilesLoading,
  onSelectPath,
  initialSelectedPath,
}: {
  files?: readonly WorkspaceFile[];
  filesError?: Error | null;
  isFilesLoading?: boolean;
  onSelectPath?: (path: string) => void;
  initialSelectedPath?: string | null;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialSelectedPath ?? null,
  );
  const controller = useManagerStorageBrowser({
    files,
    onSelectPath: (path) => {
      setSelectedPath(path);
      onSelectPath?.(path);
    },
    selectedPath,
  });
  return (
    <>
      <button
        type="button"
        aria-label="Open search"
        onClick={controller.openSearch}
      />
      <ManagerThreadStorageBrowser
        controller={controller}
        filesError={filesError ?? null}
        isFilesLoading={isFilesLoading ?? false}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  setPreferredTheme("system");
  document.documentElement.classList.remove("dark");
  treeResetCalls.length = 0;
  vi.clearAllMocks();
});

describe("ManagerThreadStorageBrowser", () => {
  it("renders tree paths and reports selection through onSelectPath", async () => {
    const onSelectPath = vi.fn();
    render(
      <Harness
        files={makeFiles(["README.md", "docs/guide.md", "docs/reports/q1.md"])}
        onSelectPath={onSelectPath}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: "README.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }));
    expect(onSelectPath).toHaveBeenCalledWith("README.md");
  });

  it("resets the tree with file paths and no auto-expanded directories by default", async () => {
    render(
      <Harness
        files={makeFiles(["README.md", "docs/guide.md", "docs/reports/q1.md"])}
      />,
    );

    await screen.findByRole("treeitem", { name: "README.md" });

    expect(treeResetCalls.at(-1)).toEqual({
      initialExpandedPaths: [],
      paths: ["README.md", "docs/guide.md", "docs/reports/q1.md"],
    });
  });

  it("syncs the shadow-root tree color-scheme with the selected theme", async () => {
    render(<Harness files={makeFiles(["README.md"])} />);

    const tree = await screen.findByRole("tree", {
      name: "Thread storage file tree",
    });

    expect(tree.style.getPropertyValue("color-scheme")).toBe("light");

    act(() => {
      setPreferredTheme("dark");
    });

    await waitFor(() => {
      expect(tree.style.getPropertyValue("color-scheme")).toBe("dark");
    });
  });

  it("filters loaded paths and auto-expands matching directories when searching", async () => {
    render(
      <Harness
        files={makeFiles(["docs/guide.md", "reports/q1.md"])}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open search"));
    fireEvent.change(screen.getByLabelText("Search files"), {
      target: { value: "reports" },
    });

    expect(
      await screen.findByRole("treeitem", { name: "reports/q1.md" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("treeitem", { name: "docs/guide.md" }),
    ).toBeNull();

    expect(treeResetCalls.at(-1)).toEqual({
      initialExpandedPaths: ["reports/"],
      paths: ["reports/q1.md"],
    });
  });

  it("shows an error message when filesError is set", () => {
    render(
      <Harness
        files={[]}
        filesError={new Error("Failed to load file list.")}
      />,
    );

    expect(screen.getByText("Failed to load file list.")).toBeTruthy();
  });

  it("shows a loading state while files are loading with no data", () => {
    render(<Harness isFilesLoading />);

    expect(screen.getByText("Loading files...")).toBeTruthy();
  });

  it("shows an empty state when there are no files", () => {
    render(<Harness files={[]} />);

    expect(screen.getByText("No files yet.")).toBeTruthy();
  });
});
