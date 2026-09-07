// @vitest-environment jsdom

import { memo, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RouteNavigationProvider,
  useRouteNavigate,
} from "@/components/ui/app-route-anchor";
import {
  ThreadActionsProvider,
  useThreadActions,
  type ThreadActionsContextValue,
} from "./ThreadActionsProvider";

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => {
  const mutationResult = { isPending: false, mutate: vi.fn() };
  const mutation = () => mutationResult;
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

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { archiveAll: vi.fn(), childSummary: vi.fn() } },
}));

afterEach(() => {
  cleanup();
});

const consumerRenders: ThreadActionsContextValue[] = [];

const ActionsConsumer = memo(function ActionsConsumer() {
  consumerRenders.push(useThreadActions());
  return null;
});

const routeNavigateIdentities: ReturnType<typeof useRouteNavigate>[] = [];

const RouteNavigateConsumer = memo(function RouteNavigateConsumer() {
  routeNavigateIdentities.push(useRouteNavigate());
  return null;
});

function NavigationProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output data-testid="pathname">{location.pathname}</output>
      <button type="button" onClick={() => navigate("/projects/p1/threads/t2")}>
        go to t2
      </button>
    </>
  );
}

function navigateToT2(): void {
  fireEvent.click(screen.getByRole("button", { name: "go to t2" }));
}

function renderTree(children: ReactNode) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/p1/threads/t1"]}>
        <RouteNavigationProvider>
          <NavigationProbe />
          {children}
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ThreadActionsProvider across navigations", () => {
  it("keeps the context value and memoized consumers stable when the route changes", () => {
    consumerRenders.length = 0;
    renderTree(
      <ThreadActionsProvider>
        <ActionsConsumer />
      </ThreadActionsProvider>,
    );
    expect(consumerRenders).toHaveLength(1);

    navigateToT2();
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/projects/p1/threads/t2",
    );
    expect(consumerRenders).toHaveLength(1);
  });
});

describe("useRouteNavigate", () => {
  it("does not re-render its caller on navigation and navigates with options", () => {
    routeNavigateIdentities.length = 0;
    renderTree(<RouteNavigateConsumer />);
    expect(routeNavigateIdentities).toHaveLength(1);

    navigateToT2();
    expect(routeNavigateIdentities).toHaveLength(1);

    const navigate = routeNavigateIdentities[0];
    act(() => {
      navigate?.("/projects/p1/threads/t3", {
        replace: true,
        state: { focusPrompt: true },
      });
    });
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/projects/p1/threads/t3",
    );
  });
});
