// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { createAppQueryClient } from "@/lib/query-client";
import {
  ProjectActionsProvider,
  useProjectActions,
} from "./ProjectActionsProvider";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localHostId: null,
    platform: null,
    pickFolder: null,
    isLocalHost: () => false,
    openPath: vi.fn(),
  }),
}));

function makeProjectResponse(overrides: Partial<Project> = {}): ProjectResponse {
  return {
    createdAt: 1,
    id: "project-1",
    name: "Project One",
    updatedAt: 1,
    sources: [],
    ...overrides,
  };
}

function renderWithProvider(children: ReactNode) {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return render(
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProjectActionsProvider>{children}</ProjectActionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>,
  );
}

/** Captures the context value so tests can invoke provider APIs directly. */
function HookProbe({
  onReady,
}: {
  onReady: (actions: ReturnType<typeof useProjectActions>) => void;
}) {
  const actions = useProjectActions();
  onReady(actions);
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectActionsProvider", () => {
  it("submits a rename and closes the dialog on success", async () => {
    const project = makeProjectResponse();
    vi.mocked(api.updateProject).mockResolvedValue({
      ...project,
      name: "Renamed project",
    });

    let actions: ReturnType<typeof useProjectActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.requestRename(project);
    });

    const input = (await screen.findByLabelText("Project name")) as HTMLInputElement;
    expect(input.value).toBe(project.name);

    fireEvent.change(input, { target: { value: "Renamed project" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith(project.id, {
        name: "Renamed project",
      });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Project name")).toBeNull();
    });
  });

  it("rejects submission with an empty name and does not call the api", async () => {
    const project = makeProjectResponse();
    let actions: ReturnType<typeof useProjectActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.requestRename(project);
    });

    const input = (await screen.findByLabelText("Project name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText(/cannot be empty/i)).not.toBeNull();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it("opens a delete confirmation and calls deleteProject when confirmed", async () => {
    const project = makeProjectResponse();
    vi.mocked(api.deleteProject).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useProjectActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.requestDelete(project);
    });

    const confirmButton = await screen.findByRole("button", {
      name: /remove project/i,
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(api.deleteProject).toHaveBeenCalledWith(project.id);
    });
  });

  it("suppresses concurrent rename requests while one is pending", () => {
    const project = makeProjectResponse();
    vi.mocked(api.updateProject).mockImplementation(() => new Promise(() => {}));

    let actions: ReturnType<typeof useProjectActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.requestRename(project);
    });
    const firstInput = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "First rename" } });
    fireEvent.submit(firstInput.closest("form")!);

    // Second request while the first mutation is still in flight should be ignored.
    act(() => {
      actions!.requestRename({ ...project, name: "Different name" });
    });
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe(
      "First rename",
    );
  });
});
