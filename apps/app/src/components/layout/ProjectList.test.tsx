import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ProjectList } from "./ProjectList"

const mockProjects = [
  {
    id: "project-1",
    name: "Project One",
    rootPath: "/tmp/project-one",
    rootPathExists: true,
  },
]

let mockThreads: Array<Record<string, unknown>> = []

vi.mock("@/hooks/useApi", () => {
  const pendingMutation = {
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }

  return {
    useProjects: () => ({
      data: mockProjects,
      isLoading: false,
    }),
    useSystemEnvironments: () => ({
      data: [],
    }),
    useThreads: () => ({
      data: mockThreads,
      isLoading: false,
    }),
    useArchiveThread: () => pendingMutation,
    useDeleteThread: () => pendingMutation,
    useDeleteProject: () => pendingMutation,
    useMarkThreadRead: () => pendingMutation,
    useMarkThreadUnread: () => pendingMutation,
    useUnarchiveThread: () => pendingMutation,
    useUpdateProject: () => pendingMutation,
    useUpdateThread: () => pendingMutation,
  }
})

vi.mock("@/lib/projectPathInput", () => ({
  deriveProjectNameFromPath: vi.fn(),
  requestProjectRootPath: vi.fn(),
}))

vi.mock("@/components/thread/ThreadActionsMenu", () => ({
  ThreadActionsMenu: () => null,
}))

vi.mock("@/components/thread/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}))

vi.mock("@/components/thread/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

describe("ProjectList", () => {
  it("renders a full-row project link target", () => {
    mockThreads = []
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <ProjectList onNewProject={vi.fn()} />
      </MemoryRouter>
    )

    expect(html).toContain('href="/projects/project-1"')
    expect(html).toContain("absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2")
    expect(html).toContain("Project One")
  })

  it("renders manager threads first with indented managed children", () => {
    mockThreads = [
      {
        id: "thread-user-1",
        projectId: "project-1",
        providerId: "codex",
        type: "standard",
        title: "Other thread",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "thread-manager-1",
        projectId: "project-1",
        providerId: "codex",
        type: "manager",
        title: "Manager",
        status: "idle",
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: "thread-managed-1",
        projectId: "project-1",
        providerId: "codex",
        type: "standard",
        title: "Managed child",
        parentThreadId: "thread-manager-1",
        status: "idle",
        createdAt: 2,
        updatedAt: 2,
      },
    ]

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <ProjectList onNewProject={vi.fn()} selectedProjectId="project-1" />
      </MemoryRouter>
    )

    expect(html.indexOf("Manager")).toBeLessThan(html.indexOf("Other thread"))
    expect(html).toContain("Managed child")
    expect(html).toContain("Collapse managed threads")
    expect(html).toContain("pl-6")
    expect(html).not.toContain("rounded-lg border border-sidebar-border/60 bg-sidebar-accent/5")
  })
})
