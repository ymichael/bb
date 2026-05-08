// @vitest-environment jsdom

import { Suspense, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import type { ProjectResponse } from "@bb/server-contract";
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

function makeProjectResponse(): ProjectResponse {
  return {
    createdAt: 1,
    id: "project-1",
    name: "Project One",
    sources: [],
    updatedAt: 1,
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

async function renderProjectList(): Promise<ProjectListRenderResult> {
  const { queryClient, wrapper } = createProjectListWrapper();
  let container: HTMLElement | null = null;

  await act(async () => {
    const result = render(<ProjectList />, { wrapper });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectList", () => {
  it("renders the sticky project heading without a sidebar overflow fade", async () => {
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
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

    await renderProjectList();

    const projectHeading = screen.getByText("Projects");
    const projectGroup = projectHeading.parentElement;

    expect(projectHeading.getAttribute("data-sidebar-sticky-tier")).toBe(
      "label",
    );
    expect(
      projectGroup?.hasAttribute("data-sidebar-sticky-stack") ?? false,
    ).toBe(true);

    expect(projectHeading.querySelector("[data-overflow-fade]")).toBeNull();
  });

  it("keeps showing project skeletons when the project request fails before the websocket connects", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: () => new Response("starting", { status: 503 }),
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

    const { container, queryClient } = await renderProjectList();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(queryClient.getQueryState(projectsQueryKey())?.status).toBe(
        "error",
      );
    });
    expect(
      container.querySelectorAll('[data-sidebar="menu-skeleton"]').length,
    ).toBeGreaterThan(0);
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
    FakeReconnectingWebSocket.latest().open();

    await renderProjectList();

    expect(await screen.findByText("Projects unavailable")).toBeTruthy();
    expect(screen.queryByText("No projects")).toBeNull();
  });

  it("shows threads unavailable when a project thread list fails after the websocket connects", async () => {
    installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: () => jsonResponse([makeProjectResponse()]),
      },
      {
        pathname: "/api/v1/threads",
        handler: () => new Response("starting", { status: 503 }),
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
