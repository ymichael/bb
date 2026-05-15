// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ThreadType } from "@bb/domain";
import { Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentFilePreviewSource,
  WorkspaceFilePreviewStatusLabel,
} from "@/lib/file-preview";
import {
  createEmptyThreadSecondaryPanelState,
  EMPTY_THREAD_SECONDARY_PANEL_STATE,
  getThreadSecondaryPanelStateStorageKey,
  parseThreadSecondaryPanelState,
  serializeThreadSecondaryPanelState,
  type ThreadSecondaryPanelState,
  type WorkspaceFileTabState,
} from "@/lib/thread-secondary-panel-state";
import { useThreadFileTabs } from "./useThreadFileTabs";

const NOW = 1_700_000_000_000;
const WORKING_TREE_SOURCE: EnvironmentFilePreviewSource = {
  kind: "working-tree",
};
const MERGE_BASE_SOURCE: EnvironmentFilePreviewSource = {
  kind: "merge-base",
  ref: "abc1234",
};
const DELETED_STATUS_LABEL: WorkspaceFilePreviewStatusLabel = "deleted";

interface TestWrapperProps {
  children: ReactNode;
}

interface HookProps {
  environmentId: string | null | undefined;
  storageFiles: readonly { path: string }[] | undefined;
  threadId: string;
  threadType: ThreadType | undefined;
}

interface BuildWorkspaceFileTabArgs {
  lineNumber: number | null;
  path: string;
  source?: EnvironmentFilePreviewSource;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

function buildWorkspaceFileTab({
  lineNumber,
  path,
  source = WORKING_TREE_SOURCE,
  statusLabel = null,
}: BuildWorkspaceFileTabArgs): WorkspaceFileTabState {
  return {
    lineNumber,
    path,
    source,
    statusLabel,
  };
}

function TestWrapper({ children }: TestWrapperProps) {
  return (
    <JotaiProvider>
      <MemoryRouter>{children}</MemoryRouter>
    </JotaiProvider>
  );
}

function renderThreadFileTabsHook(initialProps: HookProps) {
  return renderHook((props: HookProps) => useThreadFileTabs(props), {
    initialProps,
    wrapper: TestWrapper,
  });
}

function readStoredState(threadId: string): ThreadSecondaryPanelState {
  return parseThreadSecondaryPanelState({
    initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
    now: Date.now(),
    storedValue: window.localStorage.getItem(
      getThreadSecondaryPanelStateStorageKey({ threadId }),
    ),
  });
}

function seedStoredState(
  threadId: string,
  state: ThreadSecondaryPanelState,
): void {
  window.localStorage.setItem(
    getThreadSecondaryPanelStateStorageKey({ threadId }),
    serializeThreadSecondaryPanelState({ state }),
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useThreadFileTabs", () => {
  it("persists workspace tabs for the current thread", () => {
    const { result } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-one",
    });
    const workspaceTab = buildWorkspaceFileTab({
      lineNumber: 42,
      path: "src/app.ts",
    });

    act(() => {
      result.current.openWorkspaceFile(workspaceTab);
    });

    expect(result.current.openWorkspaceFileTabs).toEqual([workspaceTab]);
    expect(result.current.activeWorkspaceFilePath).toBe("src/app.ts");
    expect(result.current.activeWorkspaceFileSource).toEqual(
      WORKING_TREE_SOURCE,
    );
    expect(result.current.activeWorkspaceFileStatusLabel).toBeNull();
    expect(readStoredState("thr-one").fileTabs.workspace).toEqual([
      workspaceTab,
    ]);
    expect(readStoredState("thr-one").activePanel).toBe("thread-info");
  });

  it("keeps file tabs isolated by thread id", () => {
    const { result, rerender } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-one",
    });
    const workspaceTab = buildWorkspaceFileTab({
      lineNumber: null,
      path: "src/one.ts",
    });

    act(() => {
      result.current.openWorkspaceFile(workspaceTab);
    });

    rerender({
      environmentId: "env-two",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-two",
    });

    expect(result.current.openWorkspaceFileTabs).toEqual([]);
    expect(result.current.activeWorkspaceFilePath).toBeNull();

    rerender({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-one",
    });

    expect(result.current.openWorkspaceFileTabs).toEqual([workspaceTab]);
    expect(result.current.activeWorkspaceFilePath).toBe("src/one.ts");
  });

  it("keeps workspace and storage active tabs mutually exclusive", async () => {
    const { result } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }, { path: "notes.md" }],
      threadId: "thr-manager",
    });

    await waitFor(() => {
      expect(result.current.activeStorageFilePath).toBe("STATUS.md");
    });

    act(() => {
      result.current.openWorkspaceFile(
        buildWorkspaceFileTab({
          lineNumber: null,
          path: "src/workspace.ts",
        }),
      );
    });
    expect(result.current.activeWorkspaceFilePath).toBe("src/workspace.ts");
    expect(result.current.activeStorageFilePath).toBeNull();

    act(() => {
      result.current.openStorageFile("notes.md");
    });
    expect(result.current.activeWorkspaceFilePath).toBeNull();
    expect(result.current.activeStorageFilePath).toBe("notes.md");
  });

  it("opens, activates, and closes host-file tabs", () => {
    const { result } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-host-files",
    });
    const firstTab = {
      lineNumber: 12,
      path: "/Users/me/notes/plan.md",
    };
    const secondTab = {
      lineNumber: null,
      path: "/Users/me/notes/todo.md",
    };

    act(() => {
      result.current.openHostFile(firstTab);
      result.current.openHostFile(secondTab);
    });

    expect(result.current.openHostFileTabs).toEqual([firstTab, secondTab]);
    expect(result.current.activeHostFilePath).toBe(secondTab.path);
    expect(result.current.activeHostFileLineNumber).toBeNull();
    expect(readStoredState("thr-host-files").activePanel).toBe("thread-info");

    act(() => {
      result.current.activateHostFileTab(firstTab.path);
    });
    expect(result.current.activeHostFilePath).toBe(firstTab.path);
    expect(result.current.activeHostFileLineNumber).toBe(12);

    act(() => {
      result.current.closeHostFileTab(firstTab.path);
    });
    expect(result.current.openHostFileTabs).toEqual([secondTab]);
    expect(result.current.activeHostFilePath).toBeNull();
  });

  it("updates host-file line numbers without duplicating tabs", () => {
    const { result } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-host-file-dedupe",
    });
    const path = "/Users/me/notes/plan.md";

    act(() => {
      result.current.openHostFile({ lineNumber: 12, path });
      result.current.openHostFile({ lineNumber: 20, path });
    });

    expect(result.current.openHostFileTabs).toEqual([{ lineNumber: 20, path }]);
    expect(result.current.activeHostFileLineNumber).toBe(20);
  });

  it("clears workspace tabs when the environment changes", async () => {
    const { result, rerender } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-one",
    });
    act(() => {
      result.current.openWorkspaceFile(
        buildWorkspaceFileTab({
          lineNumber: null,
          path: "src/app.ts",
        }),
      );
    });

    rerender({
      environmentId: "env-two",
      threadType: "standard",
      storageFiles: undefined,
      threadId: "thr-one",
    });

    await waitFor(() => {
      expect(result.current.openWorkspaceFileTabs).toEqual([]);
    });
    expect(result.current.activeWorkspaceFilePath).toBeNull();
  });

  it("seeds and prunes manager storage tabs", async () => {
    const { result, rerender } = renderThreadFileTabsHook({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }, { path: "notes.md" }],
      threadId: "thr-manager",
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual(["STATUS.md"]);
    });

    act(() => {
      result.current.openStorageFile("notes.md");
    });
    expect(result.current.openStorageFilePaths).toEqual([
      "STATUS.md",
      "notes.md",
    ]);

    rerender({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }],
      threadId: "thr-manager",
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual(["STATUS.md"]);
    });
    expect(result.current.activeStorageFilePath).toBeNull();
  });

  it("keeps seeded manager storage tabs while thread type is unresolved", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-manager-cold-load";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        fileTabs: {
          workspace: [],
          storage: ["STATUS.md", "notes.md"],
          hostFiles: [],
          active: { type: "storage", path: "notes.md" },
        },
        lastUsedAt: NOW,
      }),
    );
    const { result, rerender } = renderThreadFileTabsHook({
      environmentId: undefined,
      threadType: undefined,
      storageFiles: undefined,
      threadId,
    });

    expect(result.current.openStorageFilePaths).toEqual([]);
    expect(readStoredState(threadId).fileTabs.storage).toEqual([
      "STATUS.md",
      "notes.md",
    ]);
    expect(readStoredState(threadId).fileTabs.active).toEqual({
      type: "storage",
      path: "notes.md",
    });

    rerender({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }, { path: "notes.md" }],
      threadId,
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual([
        "STATUS.md",
        "notes.md",
      ]);
    });
    expect(result.current.activeStorageFilePath).toBe("notes.md");
  });

  it("keeps seeded workspace tabs while thread environment is unresolved", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-workspace-cold-load";
    const workspaceTab = buildWorkspaceFileTab({
      lineNumber: 7,
      path: "src/app.ts",
    });
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        environmentId: "env-one",
        fileTabs: {
          workspace: [workspaceTab],
          storage: [],
          hostFiles: [],
          active: { type: "workspace", path: "src/app.ts" },
        },
        lastUsedAt: NOW,
      }),
    );
    const { result, rerender } = renderThreadFileTabsHook({
      environmentId: undefined,
      threadType: undefined,
      storageFiles: undefined,
      threadId,
    });

    expect(result.current.openWorkspaceFileTabs).toEqual([]);
    expect(readStoredState(threadId).fileTabs.workspace).toEqual([
      workspaceTab,
    ]);
    expect(readStoredState(threadId).fileTabs.active).toEqual({
      type: "workspace",
      path: "src/app.ts",
    });

    rerender({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId,
    });

    await waitFor(() => {
      expect(result.current.openWorkspaceFileTabs).toEqual([workspaceTab]);
    });
    expect(result.current.activeWorkspaceFilePath).toBe("src/app.ts");
  });

  it("seeds the pinned manager tab without stealing active seeded storage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-manager-seeded-active";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        fileTabs: {
          workspace: [],
          storage: ["notes.md"],
          hostFiles: [],
          active: { type: "storage", path: "notes.md" },
        },
        lastUsedAt: NOW,
      }),
    );
    const { result } = renderThreadFileTabsHook({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }, { path: "notes.md" }],
      threadId,
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual([
        "STATUS.md",
        "notes.md",
      ]);
    });
    expect(result.current.activeStorageFilePath).toBe("notes.md");
  });

  it("keeps the pinned manager storage tab open when close is requested", async () => {
    const { result } = renderThreadFileTabsHook({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }],
      threadId: "thr-manager-pinned",
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual(["STATUS.md"]);
    });

    act(() => {
      result.current.closeStorageFileTab("STATUS.md");
    });

    expect(result.current.openStorageFilePaths).toEqual(["STATUS.md"]);
    expect(result.current.activeStorageFilePath).toBe("STATUS.md");
  });

  it("keeps the pinned manager storage tab when the file list omits it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-manager-pinned-omitted";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        fileTabs: {
          workspace: [],
          storage: ["STATUS.md", "notes.md"],
          hostFiles: [],
          active: { type: "storage", path: "STATUS.md" },
        },
        lastUsedAt: NOW,
      }),
    );
    const { result } = renderThreadFileTabsHook({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "notes.md" }],
      threadId,
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual([
        "STATUS.md",
        "notes.md",
      ]);
    });
    expect(result.current.activeStorageFilePath).toBe("STATUS.md");
    expect(readStoredState(threadId).fileTabs.storage).toEqual([
      "STATUS.md",
      "notes.md",
    ]);
  });

  it("does not rewrite workspace tabs for no-op callbacks", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-workspace-no-op";
    const workspaceTab = buildWorkspaceFileTab({
      lineNumber: 3,
      path: "src/app.ts",
      source: MERGE_BASE_SOURCE,
      statusLabel: DELETED_STATUS_LABEL,
    });
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        environmentId: "env-one",
        fileTabs: {
          workspace: [workspaceTab],
          storage: [],
          hostFiles: [],
          active: { type: "workspace", path: "src/app.ts" },
        },
        lastUsedAt: NOW,
      }),
    );
    const { result } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId,
    });
    dateNowSpy.mockReturnValue(NOW + 60_000);

    act(() => {
      result.current.openWorkspaceFile(workspaceTab);
      result.current.activateWorkspaceFileTab("src/app.ts");
      result.current.closeWorkspaceFileTab("src/missing.ts");
    });

    expect(readStoredState(threadId).lastUsedAt).toBe(NOW);
    expect(result.current.openWorkspaceFileTabs).toEqual([workspaceTab]);
  });

  it("does not rewrite manager storage tabs for no-op callbacks", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-storage-no-op";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        fileTabs: {
          workspace: [],
          storage: ["STATUS.md", "notes.md"],
          hostFiles: [],
          active: { type: "storage", path: "notes.md" },
        },
        lastUsedAt: NOW,
      }),
    );
    const { result } = renderThreadFileTabsHook({
      environmentId: null,
      threadType: "manager",
      storageFiles: [{ path: "STATUS.md" }, { path: "notes.md" }],
      threadId,
    });

    await waitFor(() => {
      expect(result.current.activeStorageFilePath).toBe("notes.md");
    });
    dateNowSpy.mockReturnValue(NOW + 60_000);

    act(() => {
      result.current.openStorageFile("notes.md");
      result.current.activateStorageFileTab("notes.md");
      result.current.closeStorageFileTab("STATUS.md");
    });

    expect(readStoredState(threadId).lastUsedAt).toBe(NOW);
    expect(readStoredState(threadId).fileTabs.storage).toEqual([
      "STATUS.md",
      "notes.md",
    ]);
  });

  it("ignores stored storage tabs for standard threads", async () => {
    const threadId = "thr-standard";
    window.localStorage.setItem(
      getThreadSecondaryPanelStateStorageKey({ threadId }),
      serializeThreadSecondaryPanelState({
        state: createEmptyThreadSecondaryPanelState({
          fileTabs: {
            workspace: [],
            storage: ["STATUS.md"],
            hostFiles: [],
            active: { type: "storage", path: "STATUS.md" },
          },
          lastUsedAt: Date.now(),
        }),
      }),
    );

    const { result } = renderThreadFileTabsHook({
      environmentId: "env-one",
      threadType: "standard",
      storageFiles: undefined,
      threadId,
    });

    await waitFor(() => {
      expect(result.current.openStorageFilePaths).toEqual([]);
    });
    expect(result.current.activeStorageFilePath).toBeNull();
    expect(readStoredState(threadId).fileTabs.storage).toEqual([]);
  });
});
