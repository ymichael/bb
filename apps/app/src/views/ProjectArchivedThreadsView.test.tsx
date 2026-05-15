// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHIVED_THREADS_PAGE_SIZE } from "@/hooks/queries/archived-threads-page-size";
import {
  type FetchRoute,
  installFetchRoutes,
  jsonResponse,
} from "@/test/http-test-utils";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ProjectArchivedThreadsView } from "./ProjectArchivedThreadsView";

vi.mock("@/hooks/queries/archived-threads-page-size", () => ({
  ARCHIVED_THREADS_PAGE_SIZE: 2,
}));

interface ArchivedThreadsWrapperProps {
  children: ReactNode;
}

interface ArchivedThreadListRequest {
  archived: string | null;
  limit: string | null;
  managed: string | null;
  offset: string | null;
}

interface RenderProjectArchivedThreadsViewArgs {
  onThreadListRequest?: (request: ArchivedThreadListRequest) => void;
  routes?: FetchRoute[];
  /**
   * Either a fixed list of threads (returned regardless of paging) or a
   * function that resolves the list given the requested offset/limit/managed.
   */
  threads:
    | ThreadListEntry[]
    | ((request: ArchivedThreadListRequest) => ThreadListEntry[]);
}

interface DeferredResponse {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}

function createThread(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return {
    archivedAt: 10,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    id: "thr_root",
    lastReadAt: null,
    latestAttentionAt: 1,
    parentThreadId: null,
    projectId: "proj_1",
    providerId: "codex",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    status: "idle",
    stopRequestedAt: null,
    title: "Archived thread",
    titleFallback: "Archived thread",
    type: "standard",
    updatedAt: 1,
    ...overrides,
  };
}

function readArchivedThreadListRequest(
  request: Request,
): ArchivedThreadListRequest {
  const url = new URL(request.url);
  expect(url.searchParams.get("projectId")).toBe("proj_1");
  return {
    archived: url.searchParams.get("archived"),
    limit: url.searchParams.get("limit"),
    managed: url.searchParams.get("managed"),
    offset: url.searchParams.get("offset"),
  };
}

function createArchivedThreadsWrapper() {
  const harness = createQueryClientTestHarness();

  function ArchivedThreadsWrapper({ children }: ArchivedThreadsWrapperProps) {
    return harness.wrapper({
      children: (
        <MemoryRouter initialEntries={["/projects/proj_1/archived"]}>
          <Routes>
            <Route path="/projects/:projectId/archived" element={children} />
          </Routes>
        </MemoryRouter>
      ),
    });
  }

  return { wrapper: ArchivedThreadsWrapper };
}

function createDeferredResponse(): DeferredResponse {
  let resolvePromise: (response: Response) => void = (_response) => {
    throw new Error("Deferred response resolved before initialization");
  };
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (response) => {
      resolvePromise(response);
    },
  };
}

async function renderProjectArchivedThreadsView(
  args: RenderProjectArchivedThreadsViewArgs,
): Promise<void> {
  installFetchRoutes([
    {
      pathname: "/api/v1/threads",
      handler: (request) => {
        const parsedRequest = readArchivedThreadListRequest(request);
        expect(parsedRequest.archived).toBe("true");
        expect(parsedRequest.limit).toBe(String(ARCHIVED_THREADS_PAGE_SIZE));
        args.onThreadListRequest?.(parsedRequest);
        const threads =
          typeof args.threads === "function"
            ? args.threads(parsedRequest)
            : args.threads;
        return jsonResponse(threads);
      },
    },
    ...(args.routes ?? []),
  ]);

  const { wrapper } = createArchivedThreadsWrapper();

  await act(async () => {
    render(<ProjectArchivedThreadsView />, { wrapper });
  });
}

async function renderLoadedArchivedThreads(
  args: RenderProjectArchivedThreadsViewArgs,
): Promise<void> {
  await renderProjectArchivedThreadsView(args);
  await screen.findByText("Root archived thread");
}

function getThreadLinkText(): string[] {
  return screen.getAllByRole("link").map((link) => link.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectArchivedThreadsView", () => {
  it("filters threads with null archivedAt from the response", async () => {
    await renderProjectArchivedThreadsView({
      threads: [
        createThread({
          archivedAt: 20,
          id: "thr_root",
          title: "Root archived thread",
          titleFallback: "Root archived thread",
        }),
        createThread({
          archivedAt: null,
          id: "thr_live_managed",
          parentThreadId: "thr_manager",
          title: "Live managed thread",
          titleFallback: "Live managed thread",
        }),
      ],
    });

    expect(await screen.findByText("Root archived thread")).toBeTruthy();
    expect(screen.queryByText("Live managed thread")).toBeNull();
  });

  it("requests the next page when Load more is clicked", async () => {
    const firstPage = [
      createThread({
        archivedAt: 1000,
        id: "thr_page1_0",
        title: "Page1 thread 0",
        titleFallback: "Page1 thread 0",
      }),
      createThread({
        archivedAt: 999,
        id: "thr_page1_1",
        title: "Page1 thread 1",
        titleFallback: "Page1 thread 1",
      }),
    ];
    const secondPage = [
      createThread({
        archivedAt: 5,
        id: "thr_page2",
        title: "Page2 thread",
        titleFallback: "Page2 thread",
      }),
    ];
    const requestedOffsets: string[] = [];

    await renderProjectArchivedThreadsView({
      onThreadListRequest: (request) => {
        requestedOffsets.push(request.offset ?? "");
      },
      threads: (request) => {
        if (request.offset === null || request.offset === "0") {
          return firstPage;
        }
        if (request.offset === String(ARCHIVED_THREADS_PAGE_SIZE)) {
          return secondPage;
        }
        return [];
      },
    });

    await screen.findByText("Page1 thread 0");
    expect(screen.queryByText("Page2 thread")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await screen.findByText("Page2 thread");
    expect(requestedOffsets).toContain(String(ARCHIVED_THREADS_PAGE_SIZE));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("refetches with managed filter when the selector changes", async () => {
    const requestedManaged: Array<string | null> = [];

    await renderProjectArchivedThreadsView({
      onThreadListRequest: (request) => {
        requestedManaged.push(request.managed);
      },
      threads: (request) => {
        if (request.managed === "true") {
          return [
            createThread({
              archivedAt: 40,
              id: "thr_managed_only",
              parentThreadId: "thr_parent",
              title: "Managed archived thread",
              titleFallback: "Managed archived thread",
            }),
          ];
        }
        if (request.managed === "false") {
          return [
            createThread({
              archivedAt: 30,
              id: "thr_unmanaged_only",
              title: "Unmanaged archived thread",
              titleFallback: "Unmanaged archived thread",
            }),
          ];
        }
        return [
          createThread({
            archivedAt: 20,
            id: "thr_root",
            title: "Root archived thread",
            titleFallback: "Root archived thread",
          }),
        ];
      },
    });

    await screen.findByText("Root archived thread");
    expect(requestedManaged).toEqual([null]);

    fireEvent.click(screen.getByRole("tab", { name: "Managed" }));
    await screen.findByText("Managed archived thread");
    expect(requestedManaged).toContain("true");

    fireEvent.click(screen.getByRole("tab", { name: "Unmanaged" }));
    await screen.findByText("Unmanaged archived thread");
    expect(requestedManaged).toContain("false");
  });

  it("unarchives a thread and removes it optimistically", async () => {
    let unarchiveRequestCount = 0;
    const unarchiveResponse = createDeferredResponse();
    const archivedThreads = [
      createThread({
        archivedAt: 20,
        id: "thr_root",
        title: "Root archived thread",
        titleFallback: "Root archived thread",
      }),
    ];

    await renderLoadedArchivedThreads({
      threads: archivedThreads,
      routes: [
        {
          method: "POST",
          pathname: "/api/v1/threads/thr_root/unarchive",
          handler: () => {
            unarchiveRequestCount += 1;
            archivedThreads.splice(0, archivedThreads.length);
            return unarchiveResponse.promise;
          },
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Unarchive thread" }));

    await waitFor(() => {
      expect(unarchiveRequestCount).toBe(1);
      expect(screen.queryByText("Root archived thread")).toBeNull();
    });

    await act(async () => {
      unarchiveResponse.resolve(new Response(null, { status: 204 }));
    });

    expect(screen.queryByText("Root archived thread")).toBeNull();
  });
});
