import { Fragment, type ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { Link, useLocation, useMatch, useNavigate } from "react-router-dom"
import {
  Archive,
  ChevronRight,
  MoreHorizontal,
  PencilLine,
  Settings,
  UserRoundPlus,
  X,
} from "lucide-react"
import type { Thread } from "@bb/domain"
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppSidebar } from "./AppSidebar"
import {
  useHireProjectManager,
} from "@/hooks/mutations/project-mutations"
import { useProjects } from "@/hooks/queries/project-queries"
import { useThread } from "@/hooks/queries/thread-queries"
import { useDialogState } from "@/hooks/useDialogState"
import { getThreadDisplayTitle } from "@/lib/thread-title"
import { HireManagerModal } from "@/components/HireManagerModal"
import { ProjectPathDialog } from "@/components/project/ProjectPathDialog"
import { createLocalStorageSyncStorage } from "@/lib/browser-storage"
import type { QuickCreateProjectController } from "@/hooks/useQuickCreateProject"

const SIDEBAR_WIDTH_KEY = "bb.sidebar.width"
const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 460
const SIDEBAR_DEFAULT_WIDTH = 320

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value))
}

const sidebarWidthStorage = createLocalStorageSyncStorage<number>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) {
      return initialValue
    }
    const parsedValue = Number(storedValue)
    if (!Number.isFinite(parsedValue)) {
      return initialValue
    }
    return clampSidebarWidth(parsedValue)
  },
  serialize: (value) => String(clampSidebarWidth(value)),
})
const sidebarWidthAtom = atomWithStorage<number>(
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  sidebarWidthStorage,
  { getOnInit: true },
)

const routeTitles: Record<string, { title: string; subtitle?: string }> = {
  "/": { title: "Projects", subtitle: "Select or create a project" },
  "/settings": { title: "Settings" },
}

interface AppHeaderProps {
  isProjectMainView: boolean
  projectName?: string
  projectId?: string
  isManagerActionPending?: boolean
  onOpenManager?: () => void
  meta: {
    title: string
    subtitle?: string
    breadcrumbs?: Array<{ label: string; to?: string }>
  }
}

function AppHeader({
  isProjectMainView,
  projectName,
  projectId,
  isManagerActionPending = false,
  onOpenManager,
  meta,
}: AppHeaderProps) {
  const { isMobile, open, openMobile } = useSidebar()
  const isSidebarCollapsed = isMobile ? !openMobile : !open
  const showProjectMenuButton = isProjectMainView && isSidebarCollapsed
  const showProjectNameInHeader = !isProjectMainView || isSidebarCollapsed
  const collapsedProjectLabel =
    isSidebarCollapsed && isProjectMainView && projectId
      ? (projectName ?? projectId)
      : undefined
  const headerBreadcrumbs = collapsedProjectLabel
    ? [{ label: "Projects" }, { label: collapsedProjectLabel }]
    : (showProjectNameInHeader ? meta.breadcrumbs : undefined)
  const headerTitle =
    headerBreadcrumbs ? undefined : (showProjectNameInHeader ? meta.title : undefined)

  return (
    <header
      className={`relative h-12 shrink-0 px-4${isProjectMainView ? "" : " border-b border-border"}`}
    >
      <div className="flex h-full items-center">
        <SidebarTrigger className="h-5 w-5 shrink-0 rounded-md p-0" />
        <div className="ml-3 flex min-w-0 flex-1 items-center gap-2">
          {headerTitle || meta.subtitle ? (
            <Separator orientation="vertical" className="mr-2 h-4" />
          ) : null}
          <div className="min-w-0 flex-1">
            {headerBreadcrumbs ? (
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                {headerBreadcrumbs.map((segment, index) => {
                  const isLast = index === headerBreadcrumbs.length - 1
                  return (
                    <Fragment key={`${segment.label}-${index}`}>
                      {index > 0 ? (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
                      ) : null}
                      {!isLast && segment.to ? (
                        <Link
                          to={segment.to}
                          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {segment.label}
                        </Link>
                      ) : (
                        <span
                          className={
                            isLast
                              ? "min-w-0 truncate"
                              : "shrink-0 text-muted-foreground"
                          }
                        >
                          {segment.label}
                        </span>
                      )}
                    </Fragment>
                  )
                })}
              </p>
            ) : null}
            {headerTitle ? (
              <p className="truncate text-sm font-semibold">{headerTitle}</p>
            ) : null}
            {meta.subtitle ? (
              <p className="truncate text-xs text-muted-foreground">{meta.subtitle}</p>
            ) : null}
          </div>
        </div>
        {isProjectMainView && projectId ? (
          <div className="mr-2 flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Hire manager"
              title="Hire manager"
              disabled={!projectId || isManagerActionPending}
              onClick={() => onOpenManager?.()}
            >
              <UserRoundPlus className="size-4" />
            </button>
            <Link
              to={`/projects/${projectId}/settings`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Project settings"
              title="Project settings"
            >
              <Settings className="size-4" />
            </Link>
            <Link
              to={`/projects/${projectId}/archived`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Archived threads"
              title="Archived threads"
            >
              <Archive className="size-4" />
            </Link>
          </div>
        ) : null}
        {showProjectMenuButton ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Project menu"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
                <PencilLine className="size-4" />
                Edit name
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => event.preventDefault()}
                className="text-destructive focus:text-destructive"
              >
                <X className="size-4" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  )
}

interface AppLayoutProps {
  children: ReactNode
  quickCreateProject: QuickCreateProjectController
}

export function AppLayout({ children, quickCreateProject }: AppLayoutProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: projects, isLoading: projectsLoading } = useProjects()
  const hireProjectManager = useHireProjectManager()
  const hireManagerModal = useDialogState<string>()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtom)
  const [isSidebarResizing, setIsSidebarResizing] = useState(false)
  const providerRef = useRef<HTMLDivElement>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const liveWidthRef = useRef(sidebarWidth)
  const animationFrameRef = useRef<number | null>(null)

  const projectMatch = useMatch("/projects/:projectId/*")
  const projectThreadMatch = useMatch("/projects/:projectId/threads/:threadId/*")
  const projectArchivedMatch = useMatch("/projects/:projectId/archived")
  const projectSettingsMatch = useMatch("/projects/:projectId/settings")
  const threadMatch = projectThreadMatch
  const showHeader = location.pathname !== "/" && !threadMatch
  const showFloatingSidebarTrigger = location.pathname === "/"
  const isProjectMainView = Boolean(
    projectMatch && !threadMatch && !projectArchivedMatch && !projectSettingsMatch
  )
  const threadId = projectThreadMatch?.params.threadId ?? ""

  const projectId = projectMatch?.params.projectId
  const project = projectId
    ? projects?.find((candidate) => candidate.id === projectId)
    : undefined
  const projectName = projectId
    ? project?.name
    : undefined
  const projectLabel =
    projectName ??
    (projectId ? (projectsLoading ? "Loading project…" : projectId) : undefined)
  const { data: thread } = useThread(threadId)
  const threadDisplayTitle = thread
    ? getThreadDisplayTitle(thread)
    : threadId
      ? `Thread ${threadId.slice(0, 8)}`
      : "Thread"
  const meta = threadMatch
    ? {
        title: thread ? getThreadDisplayTitle(thread) : "Thread",
        subtitle: undefined,
      }
    : projectArchivedMatch && projectId
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            { label: "Projects" },
            {
              label: projectLabel ?? projectId,
              to: `/projects/${projectId}`,
            },
            { label: "Archived" },
          ],
        }
    : projectSettingsMatch && projectId
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            { label: "Projects" },
            {
              label: projectLabel ?? projectId,
              to: `/projects/${projectId}`,
            },
            { label: "Settings" },
          ],
        }
    : projectMatch && projectId
      ? {
          title: projectLabel ?? projectId,
          subtitle: undefined,
        }
      : (routeTitles[location.pathname] ?? { title: "" })

  const documentTitle = (() => {
    if (threadMatch) {
      return threadDisplayTitle
    }
    if (projectArchivedMatch && projectId) {
      return `${projectLabel ?? projectId} · Archived`
    }
    if (projectSettingsMatch && projectId) {
      return `${projectLabel ?? projectId} · Settings`
    }
    if (projectMatch && projectId) {
      return projectLabel ?? projectId
    }
    const routeTitle = routeTitles[location.pathname]?.title
    return routeTitle && routeTitle.length > 0 ? routeTitle : "BB"
  })()

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      setIsSidebarResizing(true)
      startXRef.current = event.clientX
      startWidthRef.current = liveWidthRef.current
      document.body.classList.add("sidebar-resizing")
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    []
  )

  useEffect(() => {
    if (!isSidebarResizing) return

    const applyLiveWidth = () => {
      animationFrameRef.current = null
      providerRef.current?.style.setProperty(
        "--sidebar-width",
        `${liveWidthRef.current}px`
      )
    }

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startXRef.current
      liveWidthRef.current = clampSidebarWidth(startWidthRef.current + delta)
      if (animationFrameRef.current === null) {
        animationFrameRef.current = window.requestAnimationFrame(applyLiveWidth)
      }
    }

    const handleMouseUp = () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      providerRef.current?.style.setProperty(
        "--sidebar-width",
        `${liveWidthRef.current}px`
      )
      setSidebarWidth(liveWidthRef.current)
      setIsSidebarResizing(false)
      document.body.classList.remove("sidebar-resizing")
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      document.body.classList.remove("sidebar-resizing")
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
  }, [isSidebarResizing])

  useEffect(() => {
    liveWidthRef.current = sidebarWidth
    providerRef.current?.style.setProperty("--sidebar-width", `${sidebarWidth}px`)
  }, [sidebarWidth])

  useEffect(() => {
    if (typeof document === "undefined") return
    document.title = documentTitle
  }, [documentTitle])

  return (
    <>
    <SidebarProvider
      ref={providerRef}
      className="[--sidebar-width:20rem]"
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
    >
      <AppSidebar
        onResizeMouseDown={handleResizeMouseDown}
        isResizing={isSidebarResizing}
        onNewProject={
          quickCreateProject.isAvailable ? quickCreateProject.openCreateDialog : undefined
        }
        isCreatingProject={quickCreateProject.isCreating}
      />
      <SidebarInset>
        <div className="relative flex h-[100dvh] min-w-0 w-full flex-col">
          {showFloatingSidebarTrigger ? (
            <div className="absolute left-3 top-3.5 z-20">
              <SidebarTrigger className="h-5 w-5 rounded-md p-0" />
            </div>
          ) : null}
          {showHeader ? (
            <AppHeader
              isProjectMainView={isProjectMainView}
              projectName={projectLabel}
              projectId={projectId}
              isManagerActionPending={hireProjectManager.isPending || hireManagerModal.isOpen}
              onOpenManager={() => {
                if (!projectId || hireManagerModal.isOpen) return
                hireManagerModal.onOpen(projectId)
              }}
              meta={meta}
            />
          ) : null}
          <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
            {children}
          </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
    <ProjectPathDialog
      target={quickCreateProject.projectPathDialog.target}
      pending={quickCreateProject.isCreating}
      pickFolder={quickCreateProject.pickFolder}
      onOpenChange={quickCreateProject.projectPathDialog.onOpenChange}
      onSubmit={quickCreateProject.submitProjectPath}
    />
    {hireManagerModal.target ? (
      <HireManagerModal
        projectId={hireManagerModal.target}
        open
        onClose={hireManagerModal.onClose}
        onHired={(thread: Thread) => {
          navigate(`/projects/${thread.projectId}/threads/${thread.id}`)
        }}
      />
    ) : null}
    </>
  )
}
