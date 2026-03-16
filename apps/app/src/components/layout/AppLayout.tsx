import { Fragment, type ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  Archive,
  ChevronRight,
  MoreHorizontal,
  PencilLine,
  Settings,
  UserRound,
  UserRoundPlus,
  X,
} from "lucide-react"
import type { Thread } from "@bb/core"
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
  useProjects,
  useSystemProviders,
  useThread,
  useThreads,
} from "@/hooks/useApi"
import { getThreadDisplayTitle } from "@/lib/thread-title"
import {
  formatThreadActivitySummaryForTitle,
  summarizeThreadActivity,
} from "@/lib/thread-activity"
import { HireManagerModal } from "@/components/HireManagerModal"

const SIDEBAR_WIDTH_KEY = "bb.sidebar.width"
const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 460
const SIDEBAR_DEFAULT_WIDTH = 320

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value))
}

const routeTitles: Record<string, { title: string; subtitle?: string }> = {
  "/": { title: "Projects", subtitle: "Select or create a project" },
  "/settings": { title: "Settings" },
}

interface AppHeaderProps {
  isProjectMainView: boolean
  projectMatch: RegExpMatchArray | null
  projectName?: string
  projectId?: string
  projectHasManager?: boolean
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
  projectMatch,
  projectName,
  projectId,
  projectHasManager,
  isManagerActionPending = false,
  onOpenManager,
  meta,
}: AppHeaderProps) {
  const { isMobile, open, openMobile } = useSidebar()
  const isSidebarCollapsed = isMobile ? !openMobile : !open
  const showProjectMenuButton = isProjectMainView && isSidebarCollapsed
  const showProjectNameInHeader = !isProjectMainView || isSidebarCollapsed
  const collapsedProjectLabel =
    isSidebarCollapsed && isProjectMainView && projectMatch
      ? (projectName ?? projectMatch[1])
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
        {isProjectMainView && projectMatch ? (
          <div className="mr-2 flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={projectHasManager ? "Open manager" : "Hire manager"}
              title={projectHasManager ? "Open manager" : "Hire manager"}
              disabled={!projectId || isManagerActionPending}
              onClick={() => onOpenManager?.()}
            >
              {projectHasManager ? (
                <UserRound className="size-4" />
              ) : (
                <UserRoundPlus className="size-4" />
              )}
            </button>
            <Link
              to={`/projects/${projectMatch[1]}/archived`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Archived threads"
              title="Archived threads"
            >
              <Archive className="size-4" />
            </Link>
            <Link
              to={`/projects/${projectMatch[1]}/settings`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Project settings"
              title="Project settings"
            >
              <Settings className="size-4" />
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

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: projects, isLoading: projectsLoading } = useProjects()
  const { data: threads } = useThreads()
  const hireProjectManager = useHireProjectManager()
  const providersQuery = useSystemProviders()
  const hasMultipleProviders = (providersQuery.data?.length ?? 0) >= 2
  const [hireManagerModalProjectId, setHireManagerModalProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH
    return clampSidebarWidth(parsed)
  })
  const [isSidebarResizing, setIsSidebarResizing] = useState(false)
  const providerRef = useRef<HTMLDivElement>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const liveWidthRef = useRef(sidebarWidth)
  const animationFrameRef = useRef<number | null>(null)

  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)(?:\/|$)/)
  const projectThreadMatch = location.pathname.match(
    /^\/projects\/([^/]+)\/threads\/([^/]+)(?:\/|$)/
  )
  const projectArchivedMatch = location.pathname.match(/^\/projects\/([^/]+)\/archived(?:\/|$)/)
  const projectSettingsMatch = location.pathname.match(/^\/projects\/([^/]+)\/settings(?:\/|$)/)
  const threadMatch = projectThreadMatch
  const showHeader = location.pathname !== "/" && !threadMatch
  const showFloatingSidebarTrigger = location.pathname === "/"
  const isProjectMainView = Boolean(
    projectMatch && !threadMatch && !projectSettingsMatch && !projectArchivedMatch
  )
  const threadId = projectThreadMatch?.[2] ?? ""

  const projectId = projectMatch?.[1]
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
  const projectThreads = useMemo(
    () =>
      projectId
        ? (threads ?? []).filter((candidate) => candidate.projectId === projectId)
        : [],
    [projectId, threads]
  )
  const projectThreadSummary = useMemo(
    () => formatThreadActivitySummaryForTitle(summarizeThreadActivity(projectThreads)),
    [projectThreads]
  )
  const allThreadsSummary = useMemo(
    () => formatThreadActivitySummaryForTitle(summarizeThreadActivity(threads ?? [])),
    [threads]
  )
  const meta = threadMatch
    ? {
        title: thread ? getThreadDisplayTitle(thread) : "Thread",
        subtitle: undefined,
      }
    : projectSettingsMatch
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            { label: "Projects" },
            {
              label: projectLabel ?? projectSettingsMatch[1],
              to: `/projects/${projectSettingsMatch[1]}`,
            },
            { label: "Settings" },
          ],
        }
    : projectArchivedMatch
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            { label: "Projects" },
            {
              label: projectLabel ?? projectArchivedMatch[1],
              to: `/projects/${projectArchivedMatch[1]}`,
            },
            { label: "Archived" },
          ],
        }
    : projectMatch
      ? {
          title: projectLabel ?? projectMatch[1],
          subtitle: undefined,
        }
      : (routeTitles[location.pathname] ?? { title: "" })

  const documentTitle = (() => {
    const parts: string[] = []

    if (threadMatch) {
      parts.push(threadDisplayTitle)
    } else if (projectSettingsMatch) {
      parts.push(projectLabel ?? projectSettingsMatch[1])
      parts.push("Settings")
      if (projectThreadSummary) {
        parts.push(projectThreadSummary)
      }
    } else if (projectArchivedMatch) {
      parts.push(projectLabel ?? projectArchivedMatch[1])
      parts.push("Archived")
      if (projectThreadSummary) {
        parts.push(projectThreadSummary)
      }
    } else if (projectMatch) {
      parts.push(projectLabel ?? projectMatch[1])
      if (projectThreadSummary) {
        parts.push(projectThreadSummary)
      }
    } else {
      const routeTitle = routeTitles[location.pathname]?.title
      parts.push(routeTitle && routeTitle.length > 0 ? routeTitle : "BB")
      if (allThreadsSummary) {
        parts.push(allThreadsSummary)
      }
    }

    return `bb | ${parts.join(" · ")}`
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
    if (typeof window === "undefined") return
    liveWidthRef.current = sidebarWidth
    providerRef.current?.style.setProperty("--sidebar-width", `${sidebarWidth}px`)
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
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
              projectMatch={projectMatch}
              projectName={projectLabel}
              projectId={projectId}
              projectHasManager={Boolean(project?.primaryManagerThreadId)}
              isManagerActionPending={hireProjectManager.isPending}
              onOpenManager={() => {
                if (!projectId || hireProjectManager.isPending) return
                if (project?.primaryManagerThreadId) {
                  // Open existing manager.
                  navigate(`/projects/${projectId}/threads/${project.primaryManagerThreadId}`)
                  return
                }
                if (hasMultipleProviders) {
                  setHireManagerModalProjectId(projectId)
                  return
                }
                void hireProjectManager.mutateAsync({ projectId }).then((thread) => {
                  navigate(`/projects/${thread.projectId}/threads/${thread.id}`)
                })
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
    {hireManagerModalProjectId ? (
      <HireManagerModal
        projectId={hireManagerModalProjectId}
        open
        onClose={() => setHireManagerModalProjectId(null)}
        onHired={(thread: Thread) => {
          navigate(`/projects/${thread.projectId}/threads/${thread.id}`)
        }}
      />
    ) : null}
    </>
  )
}
