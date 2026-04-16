// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { FilePreview } from "@/lib/api";
import * as api from "@/lib/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadStorageFilesQueryKey } from "@/hooks/queries/query-keys";
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
  it("defaults manager threads to the first storage file and loads its preview", async () => {
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
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFiles?.files).toHaveLength(2);
    });
    await waitFor(() => {
      expect(result.current.threadStorageFilePreview?.path).toBe("docs/alpha.txt");
    });

    expect(api.listThreadStorageFiles).toHaveBeenCalledWith("thread-1");
    expect(api.getThreadStorageFilePreview).toHaveBeenCalledWith(
      "thread-1",
      "docs/alpha.txt",
      expect.any(AbortSignal),
    );
  });

  it("preserves the selected path when it still exists after file-list updates", async () => {
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/alpha.txt", "docs/beta.txt"]),
    );
    vi.mocked(api.getThreadStorageFilePreview).mockImplementation(
      async (_threadId, path) => makeTextPreview(path),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFilePreview?.path).toBe("docs/alpha.txt");
    });

    act(() => {
      result.current.setSelectedThreadStoragePath("docs/beta.txt");
    });

    await waitFor(() => {
      expect(result.current.threadStorageFilePreview?.path).toBe("docs/beta.txt");
    });

    act(() => {
      queryClient.setQueryData(
        threadStorageFilesQueryKey("thread-1"),
        makeStorageFiles(["docs/beta.txt", "docs/gamma.txt"]),
      );
    });

    await waitFor(() => {
      expect(result.current.selectedThreadStoragePath).toBe("docs/beta.txt");
    });
    expect(result.current.threadStorageFilePreview?.path).toBe("docs/beta.txt");
  });

  it("clears invalid selections when the file list no longer includes them", async () => {
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/alpha.txt", "docs/beta.txt"]),
    );
    vi.mocked(api.getThreadStorageFilePreview).mockImplementation(
      async (_threadId, path) => makeTextPreview(path),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          threadId: "thread-1",
          threadType: "manager",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.threadStorageFilePreview?.path).toBe("docs/alpha.txt");
    });

    act(() => {
      result.current.setSelectedThreadStoragePath("docs/beta.txt");
    });

    await waitFor(() => {
      expect(result.current.selectedThreadStoragePath).toBe("docs/beta.txt");
    });

    act(() => {
      queryClient.setQueryData(
        threadStorageFilesQueryKey("thread-1"),
        makeStorageFiles(["docs/gamma.txt"]),
      );
    });

    await waitFor(() => {
      expect(result.current.selectedThreadStoragePath).toBeNull();
    });
    await waitFor(() => {
      expect(result.current.threadStorageFilePreview?.path).toBe("docs/gamma.txt");
    });
  });

  it("disables storage queries for standard threads", async () => {
    vi.mocked(api.listThreadStorageFiles).mockResolvedValue(
      makeStorageFiles(["docs/alpha.txt"]),
    );
    vi.mocked(api.getThreadStorageFilePreview).mockImplementation(
      async (_threadId, path) => makeTextPreview(path),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadStorageViewer({
          threadId: "thread-1",
          threadType: "standard",
        }),
      { wrapper },
    );

    expect(result.current.selectedThreadStoragePath).toBeNull();
    expect(result.current.threadStorageFiles).toBeUndefined();
    expect(result.current.threadStorageFilePreview).toBeUndefined();
    expect(api.listThreadStorageFiles).not.toHaveBeenCalled();
    expect(api.getThreadStorageFilePreview).not.toHaveBeenCalled();
  });
});
