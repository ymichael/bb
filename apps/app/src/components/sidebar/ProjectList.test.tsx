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
import { BrowserRouter } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import type {
  ProjectResponse,
  ProjectWithThreadsResponse,
} from "@bb/server-contract";
import {
  FakeReconnectingWebSocket,
  resetFakeReconnectingWebSockets,
} from "@/test/fake-reconnecting-websocket";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { wsManager } from "@/lib/ws";
import {
  projectsQueryKey,
  threadListQueryKey,
} from "@/hooks/queries/query-keys";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "./ProjectList";

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket: FakeSocket } =
    await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeSocket,
  };
});

interface ProjectListWrapperProps {
  children: ReactNode;
}

interface ProjectListRenderResult {
  container: HTMLElement;
  queryClient: QueryClient;
}

type ProjectThreadListEntry = ProjectWithThreadsResponse["threads"][number];
type ProjectThreadListEntryOverrides = Partial<ProjectThreadListEntry>;

function makeProjectResponse(
  overrides: Partial<ProjectResponse> = {},
): ProjectResponse {
  return {
    createdAt: 1,
    id: "project-1",
    name: "Project One",
    sources: [],
    updatedAt: 1,
    ...overrides,
  };
}

function makeThreadListEntry(
  projectId: string,
  index: number,
  overrides: ProjectThreadListEntryOverrides = {},
): ProjectThreadListEntry {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: index,
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    id: `thread-${index}`,
    lastReadAt: null,
    latestAttentionAt: index,
    parentThreadId: null,
    projectId,
    providerId: "codex",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    status: "idle",
    stopRequestedAt: null,
    title: `Thread ${index}`,
    titleFallback: `Thread ${index}`,
    type: "standard",
    updatedAt: index,
    ...overrides,
  };
}

interface ProjectListHandlerArgs {
  projects: ProjectResponse[];
  threadsByProjectId?: Map<string, ProjectWithThreadsResponse["threads"]>;
}

function buildProjectListHandler(args: ProjectListHandlerArgs) {
  return (request: Request) => {
    const url = new URL(request.url);
    if (url.searchParams.get("include") === "threads") {
      return jsonResponse(
        args.projects.map((project) => ({
          ...project,
          threads: args.threadsByProjectId?.get(project.id) ?? [],
        })),
      );
    }
    return jsonResponse(args.projects);
  };
}

function createProjectListWrapper() {
  const harness = createQueryClientTestHarness();

  function ProjectListWrapper({ children }: ProjectListWrapperProps) {
    return harness.wrapper({
      children: (
        <Suspense fallback={null}>
          <BrowserRouter>
            <ProjectActionsProvider>
              <ThreadActionsProvider>{children}</ThreadActionsProvider>
            </ProjectActionsProvider>
          </BrowserRouter>
        </Suspense>
      ),
    });
  }

  return {
    queryClient: harness.queryClient,
    wrapper: ProjectListWrapper,
  };
}

interface RenderProjectListArgs {
  selectedProjectId?: string;
}

async function renderProjectList(
  args: RenderProjectListArgs = {},
): Promise<ProjectListRenderResult> {
  const { queryClient, wrapper } = createProjectListWrapper();
  let container: HTMLElement | null = null;

  await act(async () => {
    const result = render(
      <ProjectList selectedProjectId={args.selectedProjectId} />,
      { wrapper },
    );
    container = result.container;
  });

  if (container === null) {
    throw new Error("ProjectList render did not produce a container");
  }

  return { container, queryClient };
}

afterEach(() => {
  wsManager.disconnect();
  cleanup();
  resetFakeReconnectingWebSockets();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectList", () => {
  it("primes project and thread-list caches from the sidebar bootstrap", async () => {
    let includeProjectRequestCount = 0;
    let leanProjectRequestCount = 0;
    let threadRequestCount = 0;
    const projects = [
      makeProjectResponse({ id: "project-1", name: "Project One" }),
      makeProjectResponse({ id: "project-2", name: "Project Two" }),
      makeProjectResponse({ id: "project-3", name: "Project Three" }),
    ];
    const threadsByProjectId = new Map<string, ProjectThreadListEntry[]>(
      projects.map((project, index) => [
        project.id,
        [makeThreadListEntry(project.id, index + 1)],
      ]),
    );
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("include") === "threads") {
            includeProjectRequestCount += 1;
          } else {
            leanProjectRequestCount += 1;
          }
          return buildProjectListHandler({
            projects,
            threadsByProjectId,
          })(request);
        },
      },
      {
        pathname: "/api/v1/threads",
        handler: () => {
          threadRequestCount += 1;
          return jsonResponse([]);
        },
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    const { queryClient } = await renderProjectList();

    await waitFor(() => {
      expect(queryClient.getQueryData(projectsQueryKey())).toEqual(projects);
      for (const project of projects) {
        expect(
          queryClient.getQueryData(
            threadListQueryKey({ projectId: project.id, archived: false }),
          ),
        ).toEqual(threadsByProjectId.get(project.id));
      }
    });
    expect(includeProjectRequestCount).toBe(1);
    expect(leanProjectRequestCount).toBe(0);
    expect(threadRequestCount).toBe(0);
  });

  it("collapses project-level worktree environment groups", async () => {
    const project = makeProjectResponse();
    const branchName = "feat/sidebar-collapse";
    const threads = [
      makeThreadListEntry(project.id, 1, {
        environmentBranchName: branchName,
        environmentHostId: "host-local",
        environmentId: "env-shared",
        environmentWorkspaceDisplayKind: "managed-worktree",
        id: "thread-a",
        title: "Thread A",
        titleFallback: "Thread A",
      }),
      makeThreadListEntry(project.id, 2, {
        environmentBranchName: branchName,
        environmentHostId: "host-local",
        environmentId: "env-shared",
        environmentWorkspaceDisplayKind: "managed-worktree",
        id: "thread-b",
        title: "Thread B",
        titleFallback: "Thread B",
      }),
    ];
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: buildProjectListHandler({
          projects: [project],
          threadsByProjectId: new Map([[project.id, threads]]),
        }),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    await renderProjectList({ selectedProjectId: project.id });

    expect(await screen.findByText("Thread A")).toBeTruthy();
    expect(screen.getByText("Thread B")).toBeTruthy();
    const collapseButton = screen.getByRole("button", {
      name: `Collapse Worktree: ${branchName} threads`,
    });
    expect(
      collapseButton
        .closest("[data-sidebar-sticky-tier]")
        ?.getAttribute("data-sidebar-sticky-tier"),
    ).toBe("manager");
    fireEvent.click(collapseButton);

    expect(
      screen
        .getByRole("button", {
          name: `Expand Worktree: ${branchName} threads`,
        })
        .closest("[data-sidebar-sticky-tier]")
        ?.textContent,
    ).toContain("2");
    expect(screen.queryByText("Thread A")).toBeNull();
    expect(screen.queryByText("Thread B")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Expand Worktree: ${branchName} threads`,
      }),
    );

    expect(screen.getByText("Thread A")).toBeTruthy();
    expect(screen.getByText("Thread B")).toBeTruthy();
  });

  it("badges collapsed manager rows with their child count", async () => {
    const project = makeProjectResponse();
    const manager = makeThreadListEntry(project.id, 1, {
      id: "manager-thread",
      title: "Frontend Manager",
      titleFallback: "Frontend Manager",
      type: "manager",
    });
    const threads = [
      manager,
      makeThreadListEntry(project.id, 2, {
        id: "managed-thread-a",
        parentThreadId: manager.id,
        title: "Managed Thread A",
        titleFallback: "Managed Thread A",
      }),
      makeThreadListEntry(project.id, 3, {
        id: "managed-thread-b",
        parentThreadId: manager.id,
        title: "Managed Thread B",
        titleFallback: "Managed Thread B",
      }),
    ];
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: buildProjectListHandler({
          projects: [project],
          threadsByProjectId: new Map([[project.id, threads]]),
        }),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    await renderProjectList({ selectedProjectId: project.id });

    expect(await screen.findByText("Managed Thread A")).toBeTruthy();
    const collapseButton = screen.getByRole("button", {
      name: "Collapse Frontend Manager threads",
    });
    fireEvent.click(collapseButton);

    expect(
      screen.getByRole("button", {
        name: "Expand Frontend Manager threads",
      }).textContent,
    ).toContain("2");
    expect(screen.queryByText("Managed Thread A")).toBeNull();
    expect(screen.queryByText("Managed Thread B")).toBeNull();
  });

  it("collapses managed worktree environment groups under managers", async () => {
    const project = makeProjectResponse();
    const branchName = "feat/manager-env";
    const manager = makeThreadListEntry(project.id, 1, {
      id: "manager-thread",
      title: "Frontend Manager",
      titleFallback: "Frontend Manager",
      type: "manager",
    });
    const threads = [
      manager,
      makeThreadListEntry(project.id, 2, {
        environmentBranchName: branchName,
        environmentHostId: "host-local",
        environmentId: "env-managed",
        environmentWorkspaceDisplayKind: "managed-worktree",
        id: "managed-thread-a",
        parentThreadId: manager.id,
        title: "Managed Thread A",
        titleFallback: "Managed Thread A",
      }),
      makeThreadListEntry(project.id, 3, {
        environmentBranchName: branchName,
        environmentHostId: "host-local",
        environmentId: "env-managed",
        environmentWorkspaceDisplayKind: "managed-worktree",
        id: "managed-thread-b",
        parentThreadId: manager.id,
        title: "Managed Thread B",
        titleFallback: "Managed Thread B",
      }),
    ];
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: buildProjectListHandler({
          projects: [project],
          threadsByProjectId: new Map([[project.id, threads]]),
        }),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    await renderProjectList({ selectedProjectId: project.id });

    expect(await screen.findByText("Managed Thread A")).toBeTruthy();
    expect(screen.getByText("Managed Thread B")).toBeTruthy();
    const collapseButton = screen.getByRole("button", {
      name: `Collapse Worktree: ${branchName} threads`,
    });
    expect(
      collapseButton
        .closest("[data-sidebar-sticky-tier]")
        ?.getAttribute("data-sidebar-sticky-tier"),
    ).toBe("environment");
    fireEvent.click(collapseButton);

    expect(
      screen
        .getByRole("button", {
          name: `Expand Worktree: ${branchName} threads`,
        })
        .closest("[data-sidebar-sticky-tier]")
        ?.textContent,
    ).toContain("2");
    expect(screen.getByText("Frontend Manager")).toBeTruthy();
    expect(screen.queryByText("Managed Thread A")).toBeNull();
    expect(screen.queryByText("Managed Thread B")).toBeNull();
  });

  it("does not show project error or empty states before the websocket connects", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: () => new Response("starting", { status: 503 }),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    wsManager.connect();

    const { queryClient } = await renderProjectList();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(queryClient.getQueryState(projectsQueryKey())?.status).toBe(
        "error",
      );
    });
    expect(screen.queryByText("Projects unavailable")).toBeNull();
    expect(screen.queryByText("No projects")).toBeNull();
  });

  it("shows projects unavailable when the project request fails after the websocket connects", async () => {
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: () => new Response("starting", { status: 503 }),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    wsManager.connect();
    FakeReconnectingWebSocket.latest().open();

    await renderProjectList();

    expect(await screen.findByText("Projects unavailable")).toBeTruthy();
    expect(screen.queryByText("No projects")).toBeNull();
  });

  it("shows threads unavailable when a project thread list fails after the websocket connects", async () => {
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("include") === "threads") {
            return new Response("starting", { status: 503 });
          }
          return jsonResponse([makeProjectResponse()]);
        },
      },
      {
        pathname: "/api/v1/threads",
        handler: () => new Response("starting", { status: 503 }),
      },
      {
        pathname: "/api/v1/system/config",
        handler: () =>
          jsonResponse({
            hostDaemonPort: null,
            voiceTranscriptionEnabled: false,
          }),
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => jsonResponse([]),
      },
    ]);

    wsManager.connect();
    FakeReconnectingWebSocket.latest().open();

    const { queryClient } = await renderProjectList();

    await waitFor(() => {
      expect(
        queryClient.getQueryState(
          threadListQueryKey({ projectId: "project-1", archived: false }),
        )?.status,
      ).toBe("error");
    });
    expect(screen.getByText("Threads unavailable")).toBeTruthy();
    expect(screen.queryByText("No threads")).toBeNull();
  });
});
