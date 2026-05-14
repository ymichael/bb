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
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectResponse } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCreateProjectProvider } from "@/hooks/useQuickCreateProject";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { AppSidebar } from "./AppSidebar";

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket } =
    await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeReconnectingWebSocket,
  };
});

interface TestWrapperProps {
  children: ReactNode;
}

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
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

function LocationProbe() {
  const location = useLocation();
  return <p>Location: {location.pathname}</p>;
}

function createTestWrapper() {
  const harness = createQueryClientTestHarness();

  function TestWrapper({ children }: TestWrapperProps) {
    return harness.wrapper({
      children: (
        <Suspense fallback={null}>
          <MemoryRouter initialEntries={["/projects/project-1"]}>
            <QuickCreateProjectProvider>
              <SidebarProvider>{children}</SidebarProvider>
            </QuickCreateProjectProvider>
          </MemoryRouter>
        </Suspense>
      ),
    });
  }

  return TestWrapper;
}

function installSidebarRoutes() {
  installFetchRoutes([
    {
      pathname: "/api/v1/projects",
      handler: () => jsonResponse([makeProjectResponse()]),
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
}

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppSidebar", () => {
  it("navigates the New Manager action to the routed page", async () => {
    installSidebarRoutes();
    const wrapper = createTestWrapper();

    await act(async () => {
      render(
        <>
          <AppSidebar
            onResizeMouseDown={() => {}}
            isResizing={false}
            selectedProjectId="project-1"
          />
          <LocationProbe />
        </>,
        { wrapper },
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: "New Manager" }));

    await waitFor(() => {
      expect(
        screen.getByText("Location: /projects/project-1/managers/new"),
      ).toBeTruthy();
    });
  });
});
