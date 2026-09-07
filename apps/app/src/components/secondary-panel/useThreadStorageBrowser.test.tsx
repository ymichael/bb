// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { WorkspaceFile } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadStorageBrowser } from "./useThreadStorageBrowser";

const { treesModuleEvaluated } = vi.hoisted(() => ({
  treesModuleEvaluated: vi.fn<(specifier: string) => void>(),
}));
vi.mock("@pierre/trees", async (importOriginal) => {
  treesModuleEvaluated("@pierre/trees");
  return importOriginal();
});
vi.mock("@pierre/trees/react", async (importOriginal) => {
  treesModuleEvaluated("@pierre/trees/react");
  return importOriginal();
});

const FILES: readonly WorkspaceFile[] = [
  { name: "notes.md", path: "docs/notes.md" },
  { name: "main.ts", path: "src/main.ts" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadStorageBrowser", () => {
  it("loads the tree library only once there are files to show", async () => {
    const onSelectPath = vi.fn();
    const initialProps: { files: readonly WorkspaceFile[] | undefined } = {
      files: undefined,
    };
    const { result, rerender } = renderHook(
      ({ files }: typeof initialProps) =>
        useThreadStorageBrowser({ files, onSelectPath, selectedPath: null }),
      { initialProps },
    );

    expect(treesModuleEvaluated).not.toHaveBeenCalled();
    expect(result.current.model).toBeNull();

    rerender({ files: [] });
    await Promise.resolve();
    expect(treesModuleEvaluated).not.toHaveBeenCalled();
    expect(result.current.model).toBeNull();

    rerender({ files: FILES });
    await waitFor(() => {
      expect(result.current.model).not.toBeNull();
    });
    expect(treesModuleEvaluated).toHaveBeenCalled();
  });

  it("syncs files and selection into the model once it arrives, then destroys it on unmount", async () => {
    const onSelectPath = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ selectedPath }: { selectedPath: string | null }) =>
        useThreadStorageBrowser({ files: FILES, onSelectPath, selectedPath }),
      { initialProps: { selectedPath: "src/main.ts" } },
    );

    await waitFor(() => {
      expect(result.current.model).not.toBeNull();
    });
    const model = result.current.model;
    if (model === null) throw new Error("model should be loaded");
    expect(model.getItem("src/main.ts")).not.toBeNull();
    expect(model.getItem("docs/notes.md")).not.toBeNull();
    expect(model.getSelectedPaths()).toEqual(["src/main.ts"]);

    rerender({ selectedPath: "docs/notes.md" });
    expect(model.getSelectedPaths()).toEqual(["docs/notes.md"]);
    expect(onSelectPath).not.toHaveBeenCalled();

    const cleanUp = vi.spyOn(model, "cleanUp");
    unmount();
    expect(cleanUp).toHaveBeenCalledTimes(1);
  });
});
