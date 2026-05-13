// @vitest-environment jsdom

import { Suspense, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import type {
  Environment,
  Host,
  ThreadListEntry,
  ThreadWithRuntime,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { Provider as JotaiProvider, createStore } from "jotai";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  installFetchRoutes,
  jsonResponse,
  type FetchRoute,
} from "@/test/http-test-utils";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { COMPACT_VIEWPORT_QUERY } from "@/components/ui/hooks/use-compact-viewport";
import {
  environmentQueryKey,
  threadListQueryKey,
  threadQueryKey,
  type ThreadListQueryFilters,
} from "@/hooks/queries/query-keys";
import { restoreMatchMedia, setupMatchMedia } from "@/test/helpers/match-media";
import { wsManager } from "@/lib/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadDetailView } from "./ThreadDetailView";

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
  navigateTo: (path: string) => void;
}

interface RenderThreadDetailViewOptions {
  cachedProjectThreads?: ThreadListEntry[];
  compactViewport?: boolean;
}

interface CreateThreadDetailSuccessRoutesArgs {
  environment?: Environment;
  host?: Host;
  hostDaemonPort?: number | null;
  localHostId?: string;
  managerThreads?: ThreadListEntry[];
  parentThread?: ThreadWithRuntime;
  thread: ThreadWithRuntime;
  threadListHandler?: ThreadListHandler;
  threadListRequests?: URL[];
  timelineResponse?: ThreadTimelineResponse;
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

function createEnvironmentResponse(
  overrides: Partial<Environment> = {},
): Environment {
  return {
    baseBranch: null,
    branchName: "main",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-local",
    id: "env-1",
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    mergeBaseBranch: null,
    path: "/Users/michael/.bb-dev/worktrees/env_9svzwa4syg/bb",
    projectId: "project-1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

function createHostResponse(overrides: Partial<Host> = {}): Host {
  return {
    createdAt: 1,
    id: "host-local",
    lastSeenAt: 1,
    name: "Localhost",
    status: "connected",
    type: "persistent",
    updatedAt: 1,
    ...overrides,
  };
}

function createThreadTimelineResponse(
  rows: ThreadTimelineResponse["rows"],
): ThreadTimelineResponse {
  return {
    ...EMPTY_THREAD_TIMELINE_RESPONSE,
    rows,
    timelinePage: {
      ...EMPTY_THREAD_TIMELINE_RESPONSE.timelinePage,
      returnedSegmentCount: rows.length,
    },
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
  let capturedNavigate: NavigateFunction | null = null;

  function NavigationCapture() {
    capturedNavigate = useNavigate();
    return null;
  }

  const jotaiStore = createStore();

  function ThreadDetailWrapper({ children }: ThreadDetailWrapperProps) {
    return harness.wrapper({
      children: (
        <JotaiProvider store={jotaiStore}>
          <Suspense fallback={null}>
            <MemoryRouter initialEntries={["/projects/project-1/threads/thr-1"]}>
              <NavigationCapture />
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
        </JotaiProvider>
      ),
    });
  }

  return {
    navigateTo(path: string) {
      if (!capturedNavigate) {
        throw new Error("Thread detail test router has not rendered yet");
      }
      capturedNavigate(path);
    },
    queryClient: harness.queryClient,
    wrapper: ThreadDetailWrapper,
  };
}

async function renderThreadDetailView(
  options: RenderThreadDetailViewOptions = {},
): Promise<ThreadDetailRenderResult> {
  const { navigateTo, queryClient, wrapper } = createThreadDetailWrapper();

  if (options.compactViewport) {
    setupMatchMedia({
      matchesByQuery: new Map([[COMPACT_VIEWPORT_QUERY, true]]),
    });
  }

  if (options.cachedProjectThreads) {
    queryClient.setQueryData(
      threadListQueryKey({ projectId: "project-1", archived: false }),
      options.cachedProjectThreads,
    );
  }
  await act(async () => {
    render(<ThreadDetailView />, { wrapper });
  });

  return { navigateTo, queryClient };
}

function createThreadDetailSuccessRoutes(
  args: CreateThreadDetailSuccessRoutesArgs,
): FetchRoute[] {
  const hostDaemonPort = args.hostDaemonPort ?? null;
  const host = args.host;
  const localHostId = args.localHostId ?? host?.id ?? "host-local";
  const threadId = args.thread.id;
  return [
    {
      pathname: `/api/v1/threads/${threadId}`,
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
      pathname: `/api/v1/threads/${threadId}/timeline`,
      handler: () =>
        jsonResponse(args.timelineResponse ?? EMPTY_THREAD_TIMELINE_RESPONSE),
    },
    ...(args.environment
      ? [
          {
            pathname: `/api/v1/environments/${args.environment.id}`,
            handler: () => jsonResponse(args.environment),
          },
          {
            pathname: `/api/v1/environments/${args.environment.id}/status`,
            handler: () => jsonResponse({ workspace: null }),
          },
          {
            pathname: `/api/v1/hosts/${args.environment.hostId}`,
            handler: () =>
              jsonResponse(
                host ?? createHostResponse({ id: args.environment.hostId }),
              ),
          },
        ]
      : []),
    {
      pathname: `/api/v1/threads/${threadId}/thread-storage/files`,
      handler:
        args.threadStorageFilesHandler ??
        (() => jsonResponse({ files: [], truncated: false })),
    },
    {
      pathname: "/api/v1/threads/thr-1/thread-storage/content",
      handler: () =>
        new Response("# Manager status\n", {
          headers: { "content-type": "text/markdown" },
        }),
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
      pathname: `/api/v1/threads/${threadId}/default-execution-options`,
      handler: () => jsonResponse(null),
    },
    {
      pathname: `/api/v1/threads/${threadId}/drafts`,
      handler: () => jsonResponse([]),
    },
    {
      pathname: `/api/v1/threads/${threadId}/interactions`,
      handler: () => jsonResponse([]),
    },
    {
      pathname: `/api/v1/threads/${threadId}/prompt-history`,
      handler: () => jsonResponse([]),
    },
    {
      pathname: "/api/v1/system/config",
      handler: () =>
        jsonResponse({
          githubConnected: false,
          hostDaemonPort,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: false,
        }),
    },
    {
      pathname: "/api/v1/hosts",
      handler: () => jsonResponse(host ? [host] : []),
    },
    ...(hostDaemonPort
      ? [
          {
            pathname: "/status",
            port: hostDaemonPort,
            handler: () =>
              jsonResponse({
                connected: true,
                hostId: localHostId,
                platform: "darwin",
                protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
                serverUrl: "http://localhost:3334",
                supportsNativeFolderPicker: false,
              }),
          },
          {
            pathname: "/workspace-open-targets",
            port: hostDaemonPort,
            handler: () => jsonResponse({ targets: [] }),
          },
        ]
      : []),
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
  restoreMatchMedia();
  window.localStorage.clear();
  resetFakeReconnectingWebSockets();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ThreadDetailView", () => {
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

    // For manager threads we also fire `useThreads({ parentThreadId })` to feed
    // the prompt-context's "managed children" section, so two listThreads
    // requests are expected: the prompt-mentions one (matched by the observer
    // assertion above) and the managed-children one (different query key).
    expect(listThreadsRequestCount).toBe(2);
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

  it("resets workspace preview tabs after thread navigation", async () => {
    const environmentA = createEnvironmentResponse({
      id: "env-a",
      path: "/Users/michael/.bb-dev/worktrees/env_a/bb",
    });
    const environmentB = createEnvironmentResponse({
      id: "env-b",
      path: "/Users/michael/.bb-dev/worktrees/env_b/bb",
    });
    const threadA = createThreadResponse({
      environmentId: environmentA.id,
      id: "thr-1",
      title: "Thread A",
      titleFallback: "Thread A",
    });
    const threadB = createThreadResponse({
      environmentId: environmentB.id,
      id: "thr-2",
      title: "Thread B",
      titleFallback: "Thread B",
    });
    const fileContents = Array.from({ length: 45 }, (_, index) =>
      index === 41 ? "thread A target line" : `line ${index + 1}`,
    ).join("\n");
    const threadAPreviewRequests: URL[] = [];
    const threadBPreviewRequests: URL[] = [];

    installFetchRoutes([
      ...createThreadDetailSuccessRoutes({
        environment: environmentA,
        host: createHostResponse({ id: environmentA.hostId }),
        hostDaemonPort: 4123,
        thread: threadA,
        timelineResponse: createThreadTimelineResponse([
          conversationRow({
            text: `[notes.txt](${environmentA.path ?? ""}/notes.txt:42)`,
          }),
        ]),
      }),
      ...createThreadDetailSuccessRoutes({
        environment: environmentB,
        host: createHostResponse({ id: environmentB.hostId }),
        hostDaemonPort: 4123,
        thread: threadB,
        timelineResponse: EMPTY_THREAD_TIMELINE_RESPONSE,
      }),
      {
        pathname: `/api/v1/environments/${environmentA.id}/diff/file`,
        handler: (request) => {
          threadAPreviewRequests.push(new URL(request.url));
          return jsonResponse({
            content: fileContents,
            contentEncoding: "utf8",
            mimeType: "text/plain",
            path: `${environmentA.path ?? ""}/notes.txt`,
            sizeBytes: fileContents.length,
          });
        },
      },
      {
        pathname: `/api/v1/environments/${environmentB.id}/diff/file`,
        handler: (request) => {
          threadBPreviewRequests.push(new URL(request.url));
          return jsonResponse({
            content: "stale preview should not load",
            contentEncoding: "utf8",
            mimeType: "text/plain",
            path: `${environmentB.path ?? ""}/notes.txt`,
            sizeBytes: 29,
          });
        },
      },
    ]);

    const { navigateTo, queryClient } = await renderThreadDetailView({
      compactViewport: true,
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryState(environmentQueryKey(environmentA.id))?.status,
      ).toBe("success");
    });
    const fileLink = await screen.findByRole("link", { name: /notes\.txt/ });
    fireEvent.click(fileLink);

    await waitFor(() => {
      expect(
        document.querySelector('[data-file-preview-line-number="42"]'),
      ).toBeTruthy();
    });
    expect(threadAPreviewRequests).toHaveLength(1);

    await act(async () => {
      navigateTo("/projects/project-1/threads/thr-2");
    });

    await screen.findByText("Thread B");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /notes\.txt/ })).toBeNull();
      expect(
        document.querySelector('[data-file-preview-line-number="42"]'),
      ).toBeNull();
    });
    expect(threadBPreviewRequests).toHaveLength(0);
  });

});
