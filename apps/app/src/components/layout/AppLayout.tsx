import { Fragment, type ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  Archive,
  ChevronRight,
  Settings,
  UserRoundPlus,
} from "lucide-react"
import type { Thread } from "@bb/domain"
import type { ProjectResponse } from "@bb/server-contract"
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AppSidebar } from "./AppSidebar"
import {
  useHireProjectManager,
} from "@/hooks/mutations/project-mutations"
import { useProjects } from "@/hooks/queries/project-queries"
import { useThread } from "@/hooks/queries/thread-queries"
import { useAppRoute } from "@/hooks/useAppRoute"
import { useDialogState } from "@/hooks/useDialogState"
import { getThreadDisplayTitle } from "@/lib/thread-title"
import { cn } from "@/lib/utils"
import { HireManagerModal } from "@/components/HireManagerModal"
import { ProjectPathDialog } from "@/components/project/ProjectPathDialog"
import { ProjectActionsMenu } from "@/components/project/ProjectActionsMenu"
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider"
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider"
import { createLocalStorageSyncStorage } from "@/lib/browser-storage"
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject"

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
  project?: ProjectResponse
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
  project,
  isManagerActionPending = false,
  onOpenManager,
  meta,
}: AppHeaderProps) {
  const showProjectMenuButton = isProjectMainView && !!project
  const showProjectNameInHeader = !isProjectMainView
  const headerBreadcrumbs = showProjectNameInHeader ? meta.breadcrumbs : undefined
  const headerTitle =
    headerBreadcrumbs ? undefined : (showProjectNameInHeader ? meta.title : undefined)

  return (
    <header
      className={cn("relative h-12 shrink-0 px-4", !isProjectMainView && "border-b border-border")}
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
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 md:h-8 md:w-8"
              aria-label="Hire manager"
              title="Hire manager"
              disabled={!projectId || isManagerActionPending}
              onClick={() => onOpenManager?.()}
            >
              <UserRoundPlus className="size-5 md:size-4" />
            </button>
            <Link
              to={`/projects/${projectId}/settings`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:h-8 md:w-8"
              aria-label="Project settings"
              title="Project settings"
            >
              <Settings className="size-5 md:size-4" />
            </Link>
            <Link
              to={`/projects/${projectId}/archived`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:h-8 md:w-8"
              aria-label="Archived threads"
              title="Archived threads"
            >
              <Archive className="size-5 md:size-4" />
            </Link>
            {showProjectMenuButton && project ? (
              <ProjectActionsMenu
                project={project}
                triggerClassName="h-9 w-9 [&_svg]:size-5 md:h-8 md:w-8 md:[&_svg]:size-4"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  const quickCreateProject = useQuickCreateProjectController()
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

  const {
    projectId,
    threadId,
    isProjectMainView,
    isThreadView,
    isArchivedView,
    isSettingsView,
    isRootView,
  } = useAppRoute()
  const showHeader = !isRootView && !isThreadView
  const showFloatingSidebarTrigger = isRootView

  const project = projectId
    ? projects?.find((candidate) => candidate.id === projectId)
    : undefined
  const projectName = projectId ? project?.name : undefined
  const projectLabel =
    projectName ??
    (projectId ? (projectsLoading ? "Loading project…" : projectId) : undefined)
  const { data: thread } = useThread(threadId ?? "")
  const threadDisplayTitle = thread
    ? getThreadDisplayTitle(thread)
    : threadId
      ? `Thread ${threadId.slice(0, 8)}`
      : "Thread"
  const meta = isThreadView
    ? {
        title: thread ? getThreadDisplayTitle(thread) : "Thread",
        subtitle: undefined,
      }
    : isArchivedView && projectId
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            {
              label: projectLabel ?? projectId,
              to: `/projects/${projectId}`,
            },
            { label: "Archived" },
          ],
        }
    : isSettingsView && projectId
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            {
              label: projectLabel ?? projectId,
              to: `/projects/${projectId}`,
            },
            { label: "Settings" },
          ],
        }
    : projectId
      ? {
          title: projectLabel ?? projectId,
          subtitle: undefined,
        }
      : (routeTitles[location.pathname] ?? { title: "" })

  const documentTitle = (() => {
    if (isThreadView) {
      return threadDisplayTitle
    }
    if (isArchivedView && projectId) {
      return `${projectLabel ?? projectId} · Archived`
    }
    if (isSettingsView && projectId) {
      return `${projectLabel ?? projectId} · Settings`
    }
    if (projectId) {
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
  }, [isSidebarResizing, setSidebarWidth])

  useEffect(() => {
    liveWidthRef.current = sidebarWidth
    providerRef.current?.style.setProperty("--sidebar-width", `${sidebarWidth}px`)
  }, [sidebarWidth])

  useEffect(() => {
    if (typeof document === "undefined") return
    document.title = documentTitle
  }, [documentTitle])

  return (
    <ProjectActionsProvider>
      <ThreadActionsProvider>
        <SidebarProvider
          ref={providerRef}
          className="[--sidebar-width:20rem]"
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
        >
          <AppSidebar
            onResizeMouseDown={handleResizeMouseDown}
            isResizing={isSidebarResizing}
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
                  project={project}
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
          platform={quickCreateProject.platform}
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
      </ThreadActionsProvider>
    </ProjectActionsProvider>
  )
}
