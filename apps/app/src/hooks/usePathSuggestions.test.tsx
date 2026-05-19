// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { WorkspacePathEntry } from "@bb/server-contract";
import * as api from "@/lib/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { usePathSuggestions } from "./usePathSuggestions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    searchProjectPaths: vi.fn(),
    listThreadStoragePaths: vi.fn(),
  };
});

interface PathEntryFixture {
  kind: WorkspacePathEntry["kind"];
  path: string;
  score: number;
  positions?: number[];
}

interface PathListFixtureResponse {
  paths: WorkspacePathEntry[];
  truncated: boolean;
}

function getPathName(pathValue: string): string {
  return pathValue.split("/").at(-1) ?? pathValue;
}

function makePathEntry(fixture: PathEntryFixture): WorkspacePathEntry {
  return {
    kind: fixture.kind,
    path: fixture.path,
    name: getPathName(fixture.path),
    score: fixture.score,
    positions: fixture.positions ?? [],
  };
}

function makePathResponse(
  fixtures: PathEntryFixture[],
): PathListFixtureResponse {
  return {
    paths: fixtures.map(makePathEntry),
    truncated: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("usePathSuggestions", () => {
  it("returns workspace-only path suggestions", async () => {
    vi.mocked(api.searchProjectPaths).mockResolvedValue(
      makePathResponse([
        {
          kind: "file",
          path: "src/index.ts",
          score: 80,
          positions: [0, 1, 2],
        },
      ]),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        usePathSuggestions({
          projectId: "proj-1",
          query: "src",
          limit: 4,
          environmentId: null,
          includeDirectories: false,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.suggestions).toHaveLength(1);
    });

    expect(result.current.suggestions).toEqual([
      {
        source: "workspace",
        entryKind: "file",
        path: "src/index.ts",
        name: "index.ts",
        score: 80,
        positions: [0, 1, 2],
      },
    ]);
    expect(api.searchProjectPaths).toHaveBeenCalledWith({
      projectId: "proj-1",
      query: "src",
      limit: 8,
      environmentId: null,
      includeFiles: true,
      includeDirectories: false,
    });
    expect(api.listThreadStoragePaths).not.toHaveBeenCalled();
  });

  it("merges workspace and manager thread-storage results deterministically", async () => {
    vi.mocked(api.searchProjectPaths).mockResolvedValue(
      makePathResponse([
        {
          kind: "directory",
          path: "notes",
          score: 70,
          positions: [0, 1],
        },
        {
          kind: "file",
          path: "notes/project.md",
          score: 50,
          positions: [0, 1],
        },
      ]),
    );
    vi.mocked(api.listThreadStoragePaths).mockResolvedValue({
      ...makePathResponse([
        {
          kind: "file",
          path: "notes/status.md",
          score: 90,
          positions: [0, 1],
        },
      ]),
      storageRootPath: "/tmp/thread-storage",
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        usePathSuggestions({
          projectId: "proj-1",
          query: "notes",
          limit: 2,
          environmentId: "env-1",
          currentThreadId: "thr-manager",
          currentThreadType: "manager",
          includeDirectories: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.suggestions).toHaveLength(2);
    });

    expect(
      result.current.suggestions.map((suggestion) => suggestion.path),
    ).toEqual(["notes/status.md", "notes"]);
    expect(api.searchProjectPaths).toHaveBeenCalledWith({
      projectId: "proj-1",
      query: "notes",
      limit: 4,
      environmentId: "env-1",
      includeFiles: true,
      includeDirectories: true,
    });
    expect(api.listThreadStoragePaths).toHaveBeenCalledWith({
      id: "thr-manager",
      options: {
        limit: 4,
        query: "notes",
        includeFiles: true,
        includeDirectories: true,
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("does not query thread storage for non-manager threads", async () => {
    vi.mocked(api.searchProjectPaths).mockResolvedValue(
      makePathResponse([
        {
          kind: "file",
          path: "src/app.ts",
          score: 40,
        },
      ]),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        usePathSuggestions({
          projectId: "proj-1",
          query: "app",
          environmentId: "env-1",
          currentThreadId: "thr-standard",
          currentThreadType: "standard",
          includeDirectories: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.suggestions).toHaveLength(1);
    });

    expect(api.listThreadStoragePaths).not.toHaveBeenCalled();
  });
});
