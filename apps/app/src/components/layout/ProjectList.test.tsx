import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ProjectList } from "./ProjectList"

vi.mock("@/hooks/useApi", () => {
  const pendingMutation = {
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }

  return {
    useProjects: () => ({
      data: [
        {
          id: "project-1",
          name: "Project One",
          rootPath: "/tmp/project-one",
          rootPathExists: true,
        },
      ],
      isLoading: false,
    }),
    useSystemEnvironments: () => ({
      data: [],
    }),
    useThreads: () => ({
      data: [],
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
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <ProjectList onNewProject={vi.fn()} />
      </MemoryRouter>
    )

    expect(html).toContain('href="/projects/project-1"')
    expect(html).toContain("absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2")
    expect(html).toContain("Project One")
  })
})
