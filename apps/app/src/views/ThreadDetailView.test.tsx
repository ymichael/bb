// @vitest-environment jsdom

import { Suspense, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { SidebarProvider } from "@/components/ui";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  installFetchRoutes,
  jsonResponse,
  type FetchRoute,
} from "@/test/http-test-utils";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import {
  threadListQueryKey,
  threadQueryKey,
  type ThreadListQueryFilters,
} from "@/hooks/queries/query-keys";
import { wsManager } from "@/lib/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadDetailView } from "./ThreadDetailView";
import { buildManagerSelectorOptions } from "./threadManagerSelectorOptions";

vi.unmock("@/lib/api");

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket: FakeSocket } =
    await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeSocket,
  };
});

interface ThreadDetailWrapperProps {
  children: ReactNode;
}

interface ThreadDetailRenderResult {
  queryClient: QueryClient;
}

interface RenderThreadDetailViewOptions {
  cachedProjectThreads?: ThreadListEntry[];
}

interface CreateThreadDetailSuccessRoutesArgs {
  managerThreads?: ThreadListEntry[];
  parentThread?: ThreadWithRuntime;
  thread: ThreadWithRuntime;
  threadListHandler?: ThreadListHandler;
  threadListRequests?: URL[];
  threadStorageFilesHandler?: ThreadStorageFilesHandler;
}

interface ThreadListEntryOverrides extends Partial<ThreadListEntry> {}

interface ThreadResponseOverrides extends Partial<ThreadWithRuntime> {}

interface ThreadDetailSuccessFetchRoutesArgs {
  listThreadsHandler: ThreadListHandler;
  parentThread?: ThreadWithRuntime;
  thread: ThreadWithRuntime;
  threadStorageFilesHandler?: ThreadStorageFilesHandler;
}

type ThreadListHandler = (request: Request) => Response;
type ThreadStorageFilesHandler = (request: Request) => Response;

const EMPTY_THREAD_TIMELINE_RESPONSE = {
  activeThinking: null,
  rows: [],
  timelinePage: {
    kind: "latest",
    segmentLimit: 20,
    returnedSegmentCount: 0,
    hasOlderRows: false,
    olderCursor: null,
  },
} satisfies ThreadTimelineResponse;

function createThreadResponse(
  overrides: ThreadResponseOverrides = {},
): ThreadWithRuntime {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: null,
    id: "thr-1",
    lastReadAt: null,
    latestAttentionAt: 1,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "codex",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    status: "idle",
    stopRequestedAt: null,
    title: "Loaded thread",
    titleFallback: "Loaded thread",
    type: "standard",
    updatedAt: 1,
    ...overrides,
  };
}

function createThreadListEntry(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  return {
    ...createThreadResponse({
      title: "Cached thread",
      titleFallback: "Cached thread",
    }),
    environmentBranchName: null,
    environmentHostId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    ...overrides,
  };
}

function installThreadDetailSuccessFetchRoutes({
  listThreadsHandler,
  parentThread,
  thread,
  threadStorageFilesHandler,
}: ThreadDetailSuccessFetchRoutesArgs) {
  return installFetchRoutes(
    createThreadDetailSuccessRoutes({
      parentThread,
      thread,
      threadListHandler: listThreadsHandler,
      threadStorageFilesHandler,
    }),
  );
}

function createThreadDetailWrapper() {
  const harness = createQueryClientTestHarness();

  function ThreadDetailWrapper({ children }: ThreadDetailWrapperProps) {
    return harness.wrapper({
      children: (
        <Suspense fallback={null}>
          <MemoryRouter initialEntries={["/projects/project-1/threads/thr-1"]}>
            <SidebarProvider>
              <ThreadActionsProvider>
                <Routes>
                  <Route
                    path="/projects/:projectId/threads/:threadId"
                    element={children}
                  />
                </Routes>
              </ThreadActionsProvider>
            </SidebarProvider>
          </MemoryRouter>
        </Suspense>
      ),
    });
  }

  return {
    queryClient: harness.queryClient,
    wrapper: ThreadDetailWrapper,
  };
}

async function renderThreadDetailView(
  options: RenderThreadDetailViewOptions = {},
): Promise<ThreadDetailRenderResult> {
  const { queryClient, wrapper } = createThreadDetailWrapper();

  if (options.cachedProjectThreads) {
    queryClient.setQueryData(
      threadListQueryKey({ projectId: "project-1", archived: false }),
      options.cachedProjectThreads,
    );
  }
  await act(async () => {
    render(<ThreadDetailView />, { wrapper });
  });

  return { queryClient };
}

function createThreadDetailSuccessRoutes(
  args: CreateThreadDetailSuccessRoutesArgs,
): FetchRoute[] {
  return [
    {
      pathname: "/api/v1/threads/thr-1",
      handler: () => jsonResponse(args.thread),
    },
    ...(args.parentThread
      ? [
          {
            pathname: `/api/v1/threads/${args.parentThread.id}`,
            handler: () => jsonResponse(args.parentThread),
          },
        ]
      : []),
    {
      pathname: "/api/v1/threads/thr-1/timeline",
      handler: () => jsonResponse(EMPTY_THREAD_TIMELINE_RESPONSE),
    },
    {
      pathname: "/api/v1/threads/thr-1/thread-storage/files",
      handler:
        args.threadStorageFilesHandler ??
        (() => jsonResponse({ files: [], truncated: false })),
    },
    {
      pathname: "/api/v1/threads",
      handler: (request) => {
        const requestUrl = new URL(request.url);
        args.threadListRequests?.push(requestUrl);
        if (args.threadListHandler) {
          return args.threadListHandler(request);
        }
        const isActiveManagerRequest =
          requestUrl.searchParams.get("archived") === "false" &&
          requestUrl.searchParams.get("type") === "manager";
        return jsonResponse(
          isActiveManagerRequest ? (args.managerThreads ?? []) : [],
        );
      },
    },
    {
      pathname: "/api/v1/threads/thr-1/default-execution-options",
      handler: () => jsonResponse(null),
    },
    {
      pathname: "/api/v1/threads/thr-1/drafts",
      handler: () => jsonResponse([]),
    },
    {
      pathname: "/api/v1/threads/thr-1/interactions",
      handler: () => jsonResponse([]),
    },
    {
      pathname: "/api/v1/threads/thr-1/prompt-history",
      handler: () => jsonResponse([]),
    },
    {
      pathname: "/api/v1/system/config",
      handler: () =>
        jsonResponse({
          githubConnected: false,
          hostDaemonPort: null,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: false,
        }),
    },
    {
      pathname: "/api/v1/hosts",
      handler: () => jsonResponse([]),
    },
    {
      pathname: "/api/v1/system/providers",
      handler: () =>
        jsonResponse([
          {
            available: true,
            capabilities: {
              supportedPermissionModes: ["full", "workspace-write", "readonly"],
              supportsArchive: true,
              supportsRename: true,
              supportsServiceTier: false,
            },
            displayName: "Codex",
            id: "codex",
          },
        ]),
    },
    {
      pathname: "/api/v1/system/models",
      handler: () =>
        jsonResponse([
          {
            defaultReasoningEffort: "medium",
            description: "Model description",
            displayName: "GPT 5.4",
            id: "gpt-5.4",
            isDefault: true,
            model: "gpt-5.4",
            supportedReasoningEfforts: [
              {
                description: "Medium effort",
                reasoningEffort: "medium",
              },
            ],
          },
        ]),
    },
  ];
}

function getThreadListObserverCount(
  queryClient: QueryClient,
  filters: ThreadListQueryFilters,
): number {
  return (
    queryClient
      .getQueryCache()
      .find({
        exact: true,
        queryKey: threadListQueryKey(filters),
      })
      ?.getObserversCount() ?? 0
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  wsManager.disconnect();
  cleanup();
  window.localStorage.clear();
  resetFakeReconnectingWebSockets();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ThreadDetailView", () => {
  it("builds new assignment targets from active manager query results", () => {
    const thread = createThreadResponse({ title: "Standard thread" });
    const activeManager = createThreadListEntry({
      id: "thr-manager-active",
      title: "Active manager",
      titleFallback: "Active manager",
      type: "manager",
    });

    const managerSelectorOptions = buildManagerSelectorOptions({
      currentThreadId: thread.id,
      isManagerThread: false,
      managerThreads: [activeManager],
      parentThreadDisplayName: null,
      parentThreadId: null,
    });

    expect(managerSelectorOptions).toEqual([
      { label: "None", value: "none" },
      { label: "Active manager", value: activeManager.id },
    ]);
  });

  it("keeps an already-assigned archived manager parent in selector options", () => {
    const archivedManager = createThreadResponse({
      archivedAt: 10,
      id: "thr-manager-archived",
      title: "Archived manager",
      titleFallback: "Archived manager",
      type: "manager",
    });
    const thread = createThreadResponse({
      parentThreadId: archivedManager.id,
      title: "Managed child thread",
    });

    const managerSelectorOptions = buildManagerSelectorOptions({
      currentThreadId: thread.id,
      isManagerThread: false,
      managerThreads: [],
      parentThreadDisplayName: archivedManager.title,
      parentThreadId: archivedManager.id,
    });
    const selectedManagerOption = managerSelectorOptions.find(
      (option) => option.value === archivedManager.id,
    );

    expect(selectedManagerOption).toEqual({
      label: "Archived manager",
      value: archivedManager.id,
    });
  });

  it("keeps showing loading when the thread request fails before the websocket connects", async () => {
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thr-1",
        handler: () => new Response("starting", { status: 503 }),
      },
      {
        pathname: "/api/v1/threads/thr-1/timeline",
        handler: () => jsonResponse(EMPTY_THREAD_TIMELINE_RESPONSE),
      },
      {
        pathname: "/api/v1/threads",
        handler: () => jsonResponse([]),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            githubConnected: false,
            hostDaemonPort: null,
            sandboxHostSupported: false,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    wsManager.connect();

    const { queryClient } = await renderThreadDetailView();

    await waitFor(() => {
      expect(queryClient.getQueryState(threadQueryKey("thr-1"))?.status).toBe(
        "error",
      );
    });
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByText("Failed to load thread.")).toBeNull();
  });

  it("treats cached thread-list placeholder data as unresolved before the websocket connects", async () => {
    let listThreadsRequestCount = 0;
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thr-1",
        handler: () => new Response("starting", { status: 503 }),
      },
      {
        pathname: "/api/v1/threads/thr-1/timeline",
        handler: () => jsonResponse(EMPTY_THREAD_TIMELINE_RESPONSE),
      },
      {
        pathname: "/api/v1/threads",
        handler: () => {
          listThreadsRequestCount += 1;
          return jsonResponse([]);
        },
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            githubConnected: false,
            hostDaemonPort: null,
            sandboxHostSupported: false,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    wsManager.connect();

    const { queryClient } = await renderThreadDetailView({
      cachedProjectThreads: [createThreadListEntry()],
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(threadQueryKey("thr-1"))?.status).toBe(
        "error",
      );
    });
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByText("Cached thread")).toBeNull();
    expect(screen.queryByText("Failed to load thread.")).toBeNull();
    expect(listThreadsRequestCount).toBe(0);
  });

  it("loads project threads for root standard threads so they can be assigned to managers", async () => {
    let listThreadsRequestCount = 0;
    const threadListRequests: URL[] = [];
    installThreadDetailSuccessFetchRoutes({
      thread: createThreadResponse(),
      listThreadsHandler: (request) => {
        threadListRequests.push(new URL(request.url));
        listThreadsRequestCount += 1;
        return jsonResponse([
          createThreadListEntry({
            id: "manager-1",
            title: "Manager thread",
            titleFallback: "Manager thread",
            type: "manager",
          }),
        ]);
      },
    });

    await renderThreadDetailView();

    await screen.findByText("Loaded thread");
    await waitFor(() => {
      expect(listThreadsRequestCount).toBe(1);
    });
    expect(
      threadListRequests.every(
        (requestUrl) =>
          requestUrl.searchParams.get("projectId") === "project-1" &&
          requestUrl.searchParams.get("archived") === "false" &&
          requestUrl.searchParams.get("type") === "manager",
      ),
    ).toBe(true);
  });

  it("does not add a manager-selector thread-list observer for manager threads", async () => {
    let listThreadsRequestCount = 0;
    installThreadDetailSuccessFetchRoutes({
      thread: createThreadResponse({ type: "manager" }),
      listThreadsHandler: () => {
        listThreadsRequestCount += 1;
        return jsonResponse([]);
      },
    });

    const { queryClient } = await renderThreadDetailView();
    const projectThreadFilters: ThreadListQueryFilters = {
      archived: false,
      projectId: "project-1",
    };

    await screen.findByText("Loaded thread");
    expect(getThreadListObserverCount(queryClient, projectThreadFilters)).toBe(
      1,
    );

    expect(listThreadsRequestCount).toBe(1);
    expect(getThreadListObserverCount(queryClient, projectThreadFilters)).toBe(
      1,
    );
  });

  it("does not add a manager-selector thread-list observer for managed child threads", async () => {
    let listThreadsRequestCount = 0;
    const parentThread = createThreadResponse({
      id: "manager-1",
      title: "Manager thread",
      titleFallback: "Manager thread",
      type: "manager",
    });
    installThreadDetailSuccessFetchRoutes({
      parentThread,
      thread: createThreadResponse({ parentThreadId: parentThread.id }),
      listThreadsHandler: () => {
        listThreadsRequestCount += 1;
        return jsonResponse([]);
      },
    });

    const { queryClient } = await renderThreadDetailView();
    const managerThreadFilters: ThreadListQueryFilters = {
      archived: false,
      projectId: "project-1",
      type: "manager",
    };

    await screen.findByText("Loaded thread");
    expect(getThreadListObserverCount(queryClient, managerThreadFilters)).toBe(
      1,
    );

    expect(listThreadsRequestCount).toBe(1);
    expect(getThreadListObserverCount(queryClient, managerThreadFilters)).toBe(
      1,
    );
  });

  it("only loads thread storage files for manager threads", async () => {
    let standardStorageRequestCount = 0;
    installFetchRoutes(
      createThreadDetailSuccessRoutes({
        thread: createThreadResponse({ type: "standard" }),
        threadStorageFilesHandler: () => {
          standardStorageRequestCount += 1;
          return jsonResponse({ files: [], truncated: false });
        },
      }),
    );

    await renderThreadDetailView();
    await screen.findByText("Loaded thread");
    expect(standardStorageRequestCount).toBe(0);
    cleanup();
    wsManager.disconnect();
    resetFakeReconnectingWebSockets();

    let managerStorageRequestCount = 0;
    installFetchRoutes(
      createThreadDetailSuccessRoutes({
        thread: createThreadResponse({ type: "manager" }),
        threadStorageFilesHandler: () => {
          managerStorageRequestCount += 1;
          return jsonResponse({ files: [], truncated: false });
        },
      }),
    );

    await renderThreadDetailView();
    await waitFor(() => {
      expect(managerStorageRequestCount).toBe(1);
    });
  });
});
