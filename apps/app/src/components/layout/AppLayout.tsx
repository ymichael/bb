import { Fragment, type ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  Archive,
  ChevronRight,
  MoreHorizontal,
  PanelRight,
  PencilLine,
  Settings,
  X,
} from "lucide-react"
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
  useArchiveThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useProjects,
  useSystemEnvironments,
  useThread,
  useThreads,
  useThreadWorkStatusLookup,
  useUnarchiveThread,
  useUpdateThread,
} from "@/hooks/useApi"
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu"
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog"
import { getThreadDisplayTitle } from "@/lib/thread-title"
import { cn } from "@/lib/utils"
import {
  formatThreadActivitySummaryForTitle,
  summarizeThreadActivity,
} from "@/lib/thread-activity"
import {
  isThreadGitDiffPanelOpen,
  withThreadGitDiffPanelOpen,
} from "@/lib/thread-git-diff-panel"
import { requiresArchiveConfirmation } from "@/lib/thread-archive"

const SIDEBAR_WIDTH_KEY = "beanbag.sidebar.width"
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
  meta: {
    title: string
    subtitle?: string
    breadcrumbs?: Array<{ label: string; to?: string }>
  }
  titleEndSlot?: ReactNode
}

function AppHeader({
  isProjectMainView,
  projectMatch,
  projectName,
  meta,
  titleEndSlot,
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
        {titleEndSlot ? <div className="mr-2">{titleEndSlot}</div> : null}
        {isProjectMainView && projectMatch ? (
          <div className="mr-2 flex items-center gap-1">
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
  const { data: environments } = useSystemEnvironments()
  const environmentById = useMemo(
    () => new Map((environments ?? []).map((environment) => [environment.id, environment])),
    [environments],
  )
  const { data: threads } = useThreads()
  const archiveThread = useArchiveThread()
  const unarchiveThread = useUnarchiveThread()
  const markThreadRead = useMarkThreadRead()
  const markThreadUnread = useMarkThreadUnread()
  const updateThread = useUpdateThread()
  const threadWorkStatusLookup = useThreadWorkStatusLookup()
  const showHeader = location.pathname !== "/"
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
  const [threadRenameTarget, setThreadRenameTarget] = useState<ThreadRenameDialogTarget | null>(
    null
  )

  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)(?:\/|$)/)
  const projectThreadMatch = location.pathname.match(
    /^\/projects\/([^/]+)\/threads\/([^/]+)(?:\/|$)/
  )
  const projectArchivedMatch = location.pathname.match(/^\/projects\/([^/]+)\/archived(?:\/|$)/)
  const projectSettingsMatch = location.pathname.match(/^\/projects\/([^/]+)\/settings(?:\/|$)/)
  const threadMatch = projectThreadMatch
  const isProjectMainView = Boolean(
    projectMatch && !threadMatch && !projectSettingsMatch && !projectArchivedMatch
  )
  const threadId = projectThreadMatch?.[2] ?? ""

  const projectId = projectMatch?.[1]
  const projectName = projectId
    ? projects?.find((project) => project.id === projectId)?.name
    : undefined
  const projectLabel =
    projectName ??
    (projectId ? (projectsLoading ? "Loading project…" : projectId) : undefined)
  const { data: thread } = useThread(threadId)
  const threadEnvironmentInfo = useMemo(
    () => (thread?.environmentId ? environmentById.get(thread.environmentId) : undefined),
    [environmentById, thread?.environmentId],
  )
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
  const renameThread = useCallback(() => {
    if (!thread || updateThread.isPending) return
    setThreadRenameTarget({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
    })
  }, [thread, updateThread.isPending])

  const submitThreadRename = useCallback(
    (threadId: string, title: string) => {
      updateThread.mutate(
        {
          id: threadId,
          title,
        },
        {
          onSuccess: () => {
            setThreadRenameTarget(null)
          },
        }
      )
    },
    [updateThread]
  )

  const toggleArchiveThread = useCallback(async () => {
    if (!thread) return
    if (thread.archivedAt !== undefined) {
      unarchiveThread.mutate({ id: thread.id })
      return
    }

    const workStatus =
      thread.workStatus ??
      (await threadWorkStatusLookup.mutateAsync(thread.id).catch(() => null))
    if (requiresArchiveConfirmation(workStatus, threadEnvironmentInfo)) {
      const confirmed = window.confirm(
        "This thread has uncommitted or unmerged work. Archive anyway?"
      )
      if (!confirmed) {
        return
      }
      archiveThread.mutate({ id: thread.id, force: true }, {
        onSuccess: () => {
          navigate(`/projects/${thread.projectId}`)
        },
      })
      return
    }

    archiveThread.mutate({ id: thread.id }, {
      onSuccess: () => {
        navigate(`/projects/${thread.projectId}`)
      },
    })
  }, [
    archiveThread,
    navigate,
    thread,
    threadEnvironmentInfo,
    threadWorkStatusLookup,
    unarchiveThread,
  ])

  const gitDiffPanelOpen = threadMatch
    ? isThreadGitDiffPanelOpen(location.search)
    : false

  const toggleGitDiffPanel = useCallback(() => {
    if (!threadMatch) return
    const nextSearch = withThreadGitDiffPanelOpen(location.search, !gitDiffPanelOpen)
    navigate({
      pathname: location.pathname,
      search: nextSearch.length > 0 ? `?${nextSearch}` : "",
    }, { replace: true })
  }, [gitDiffPanelOpen, location.pathname, location.search, navigate, threadMatch])

  const threadActionsMenu = thread ? (
    <ThreadActionsMenu
      triggerClassName="h-7 w-7 text-muted-foreground"
      disabled={
        archiveThread.isPending ||
        unarchiveThread.isPending ||
        markThreadRead.isPending ||
        markThreadUnread.isPending ||
        updateThread.isPending
      }
      align="end"
      isRead={(thread.lastReadAt ?? 0) >= thread.updatedAt}
      onToggleRead={() => {
        if ((thread.lastReadAt ?? 0) >= thread.updatedAt) {
          markThreadUnread.mutate(thread.id)
          return
        }
        markThreadRead.mutate(thread.id)
      }}
      onRename={renameThread}
      onToggleArchive={() => {
        void toggleArchiveThread()
      }}
      isArchived={thread.archivedAt !== undefined}
    />
  ) : null

  const threadTitleActions = threadMatch ? (
    <div className="flex items-center gap-1">
      {threadActionsMenu}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-7 w-7 text-muted-foreground",
          gitDiffPanelOpen && "bg-accent/60 text-foreground hover:bg-accent/70"
        )}
        aria-label={gitDiffPanelOpen ? "Hide git diff panel" : "Show git diff panel"}
        title={gitDiffPanelOpen ? "Hide git diff panel" : "Show git diff panel"}
        onClick={toggleGitDiffPanel}
      >
        <PanelRight className="size-4" />
      </Button>
    </div>
  ) : null

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
      parts.push(routeTitle && routeTitle.length > 0 ? routeTitle : "Beanbag")
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
          {!showHeader ? (
            <div className="absolute left-3 top-3.5 z-20">
              <SidebarTrigger className="h-5 w-5 rounded-md p-0" />
            </div>
          ) : null}
          {showHeader ? (
            <AppHeader
              isProjectMainView={isProjectMainView}
              projectMatch={projectMatch}
              projectName={projectLabel}
              meta={meta}
              titleEndSlot={threadTitleActions}
            />
          ) : null}
          <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
            {children}
          </main>
        </div>
      </SidebarInset>
      <ThreadRenameDialog
        target={threadRenameTarget}
        pending={updateThread.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setThreadRenameTarget(null)
          }
        }}
        onRename={submitThreadRename}
      />
    </SidebarProvider>
  )
}
