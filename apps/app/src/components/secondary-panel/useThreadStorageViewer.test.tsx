// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { FilePreview } from "@/lib/api";
import * as api from "@/lib/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS } from "@/lib/thread-storage-files";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadStorageViewer } from "./useThreadStorageViewer";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    getThreadStorageFilePreview: vi.fn(),
    listThreadStorageFiles: vi.fn(),
  };
});

function makeStorageFiles(paths: string[]) {
  return {
    files: paths.map((path) => ({
      name: path.split("/").at(-1) ?? path,
      path,
    })),
    truncated: false,
  };
}

function makeTextPreview(path: string): FilePreview {
  const name = path.split("/").at(-1) ?? path;

  return {
    content: `Preview for ${path}`,
    kind: "text",
    mimeType: "text/plain",
    name,
    path,
    url: `/preview/${name}`,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadStorageViewer", () => {
  it("loads the file list and skips the preview query when no path is active", async () => {
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/alpha.txt", "docs/beta.txt"]),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          activePath: null,
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFiles?.files).toHaveLength(2);
    });

    expect(result.current.threadStorageFilePreview).toBeUndefined();
    expect(api.getThreadStorageFilePreview).not.toHaveBeenCalled();
    expect(api.listThreadStorageFiles).toHaveBeenCalledWith({
      id: "thread-1",
      options: DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
      signal: expect.any(AbortSignal),
    });
  });

  it("loads the preview for the active path", async () => {
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/alpha.txt", "docs/beta.txt"]),
    );
    vi.mocked(api.getThreadStorageFilePreview).mockImplementation(
      async (_threadId, path) => makeTextPreview(path),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          activePath: "docs/beta.txt",
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFilePreview?.path).toBe(
        "docs/beta.txt",
      );
    });

    expect(api.getThreadStorageFilePreview).toHaveBeenCalledWith(
      "thread-1",
      "docs/beta.txt",
      expect.any(AbortSignal),
    );
  });

  it("disables storage queries for standard threads", async () => {
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/alpha.txt"]),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          activePath: "docs/alpha.txt",
          threadId: "thread-1",
          threadType: "standard",
        }),
      { wrapper },
    );

    expect(result.current.threadStorageFiles).toBeUndefined();
    expect(result.current.threadStorageFilePreview).toBeUndefined();
    expect(api.listThreadStorageFiles).not.toHaveBeenCalled();
    expect(api.getThreadStorageFilePreview).not.toHaveBeenCalled();
  });

  it("passes explicit file-list options through the storage query", async () => {
    const fileListOptions = {
      limit: 25,
      query: "notes",
    };
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/notes.md"]),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          activePath: null,
          fileListOptions,
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFiles?.files).toHaveLength(1);
    });

    expect(api.listThreadStorageFiles).toHaveBeenCalledWith({
      id: "thread-1",
      options: fileListOptions,
      signal: expect.any(AbortSignal),
    });
  });

  it("surfaces file-list errors separately from preview errors", async () => {
    const listError = new Error("List failed");
    vi.mocked(api.listThreadStorageFiles).mockRejectedValue(listError);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          activePath: null,
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFilesError).toBe(listError);
    });

    expect(result.current.threadStorageFilePreviewError).toBeNull();
    expect(api.getThreadStorageFilePreview).not.toHaveBeenCalled();
  });
});
