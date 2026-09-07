// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import {
  useBbContext,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@/lib/plugin-sdk-hooks";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { PluginAppOverlays } from "./PluginAppOverlays";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => {
  const mutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  });
  return {
    useArchiveThreadAndChildren: mutation,
    useDeleteThread: mutation,
    useMarkThreadRead: mutation,
    useMarkThreadUnread: mutation,
    usePinThread: mutation,
    useUnarchiveThread: mutation,
    useUnpinThread: mutation,
    useUpdateThread: mutation,
  };
});

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      personalProject: { id: "personal", name: "Personal", threads: [] },
      projects: [],
    },
    isError: false,
  }),
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function PortaledProbe() {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc();
  const settings = useSettings();
  const sidebarThreadActions =
    pluginSdkAppImplementation.experimental_useSidebarThreadActions();
  const [rpcResult, setRpcResult] = useState("idle");

  return (
    <div>
      <div data-testid="overlay-context">
        {context.projectId}/{context.threadId}
      </div>
      <div data-testid="overlay-settings">
        {settings.isLoading ? "loading" : settings.values?.mode}
      </div>
      <div data-testid="overlay-rpc">{rpcResult}</div>
      <div data-testid="overlay-sidebar-actions">
        {typeof sidebarThreadActions.openNewThread}
      </div>
      <button
        type="button"
        onClick={() => {
          void rpc.call("ping").then((result) => setRpcResult(String(result)));
        }}
      >
        Call RPC
      </button>
      <button type="button" onClick={() => navigate.toCompose()}>
        Go home
      </button>
    </div>
  );
}

function PortaledOverlay() {
  return createPortal(<PortaledProbe />, document.body);
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PluginAppOverlays", () => {
  it("does not render an existing overlay when another one registers", () => {
    const firstRender = vi.fn();
    function First() {
      firstRender();
      return <div>first overlay</div>;
    }
    function Second() {
      return <div>second overlay</div>;
    }
    setPluginSlotRegistrations(
      "first",
      registrationSet({
        appOverlays: [{ id: "first", component: First }],
      }),
    );
    render(
      <MemoryRouter>
        <PluginAppOverlays />
      </MemoryRouter>,
    );

    expect(firstRender).toHaveBeenCalledTimes(1);
    act(() => {
      setPluginSlotRegistrations(
        "second",
        registrationSet({
          appOverlays: [{ id: "second", component: Second }],
        }),
      );
    });

    expect(screen.getByText("second overlay")).toBeDefined();
    expect(firstRender).toHaveBeenCalledTimes(1);
  });

  it("keeps sidebar thread actions available through a portal and route change", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, values: { mode: "floating" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: "pong" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    setPluginSlotRegistrations(
      "office",
      registrationSet({
        appOverlays: [{ id: "widget", component: PortaledOverlay }],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/proj_1/threads/thr_1"]}>
          <RouteNavigationProvider>
            <ThreadActionsProvider>
              <PluginAppOverlays />
              <LocationProbe />
            </ThreadActionsProvider>
          </RouteNavigationProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("overlay-context").textContent).toBe(
      "proj_1/thr_1",
    );
    expect(await screen.findByText("floating")).toBeDefined();
    expect(screen.getByTestId("overlay-sidebar-actions").textContent).toBe(
      "function",
    );
    fireEvent.click(screen.getByRole("button", { name: "Call RPC" }));
    expect(await screen.findByText("pong")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/plugins/office/rpc/ping",
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(screen.getByTestId("overlay-rpc").textContent).toBe("pong");
    expect(screen.getByTestId("overlay-sidebar-actions").textContent).toBe(
      "function",
    );
  });

  it("hides a crashing overlay without unmounting additive siblings", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    function Crashes(): never {
      throw new Error("overlay crashed");
    }
    function Fine() {
      return <div>fine overlay</div>;
    }
    setPluginSlotRegistrations(
      "broken",
      registrationSet({
        appOverlays: [{ id: "broken", component: Crashes }],
      }),
    );
    setPluginSlotRegistrations(
      "fine",
      registrationSet({
        appOverlays: [{ id: "fine", component: Fine }],
      }),
    );

    render(
      <MemoryRouter>
        <PluginAppOverlays />
      </MemoryRouter>,
    );

    expect(screen.getByText("fine overlay")).toBeDefined();
    expect(screen.queryByText("plugin broken crashed")).toBeNull();
  });
});
