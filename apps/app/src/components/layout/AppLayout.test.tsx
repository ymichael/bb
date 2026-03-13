import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "./AppLayout";

const apiState = vi.hoisted(() => ({
  projects: [
    {
      id: "project-1",
      name: "Project One",
      rootPath: "/tmp/project-one",
      rootPathExists: true,
    },
  ] as Array<Record<string, unknown>>,
  threads: [],
  pendingMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
}));

vi.mock("@/hooks/useApi", () => ({
  useProjects: () => ({
    data: apiState.projects,
    isLoading: false,
  }),
  useThreads: () => ({
    data: apiState.threads,
  }),
  useThread: () => ({
    data: undefined,
  }),
  useHireProjectManager: () => apiState.pendingMutation,
}));

vi.mock("./AppSidebar", () => ({
  AppSidebar: () => <div>sidebar</div>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button className={className}>sidebar</button>
  ),
  useSidebar: () => ({
    isMobile: false,
    open: true,
    openMobile: false,
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    disabled,
    onClick,
    type,
  }: {
    children?: ReactNode;
    className?: string;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
  }) => (
    <button className={className} disabled={disabled} onClick={onClick} type={type}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

describe("AppLayout", () => {
  beforeEach(() => {
    apiState.projects = [
      {
        id: "project-1",
        name: "Project One",
        rootPath: "/tmp/project-one",
        rootPathExists: true,
      },
    ];
  });

  const renderAppLayout = () =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Routes>
          <Route
            path="/projects/:projectId"
            element={
              <AppLayout>
                <div>content</div>
              </AppLayout>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

  it("shows the hire manager action when the project has no manager", () => {
    apiState.projects = [
      {
        id: "project-1",
        name: "Project One",
        rootPath: "/tmp/project-one",
        rootPathExists: true,
      },
    ];

    const html = renderAppLayout();

    expect(html).toContain('aria-label="Hire manager"');
    expect(html).not.toContain('aria-label="Open manager"');
  });

  it("shows the open manager action when the project already has a manager", () => {
    apiState.projects = [
      {
        id: "project-1",
        name: "Project One",
        rootPath: "/tmp/project-one",
        rootPathExists: true,
        primaryManagerThreadId: "thread-manager-1",
      },
    ];

    const html = renderAppLayout();

    expect(html).toContain('aria-label="Open manager"');
    expect(html).not.toContain('aria-label="Hire manager"');
  });
});
