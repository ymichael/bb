import { Fragment, type ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { ChevronRight, MoreHorizontal, PencilLine, X } from "lucide-react"
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
import { useProjects, useThread } from "@/hooks/useApi"

const SIDEBAR_WIDTH_KEY = "beanbag.sidebar.width"
const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 460
const SIDEBAR_DEFAULT_WIDTH = 320

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value))
}

const routeTitles: Record<string, { title: string; subtitle?: string }> = {
  "/": { title: "Projects", subtitle: "Select or create a project" },
}

interface AppHeaderProps {
  isProjectMainView: boolean
  projectMatch: RegExpMatchArray | null
  projectName?: string
  meta: { title: string; subtitle?: string; breadcrumbs?: string[] }
}

function AppHeader({
  isProjectMainView,
  projectMatch,
  projectName,
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
    ? ["Projects", collapsedProjectLabel]
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
                    <Fragment key={`${segment}-${index}`}>
                      {index > 0 ? (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
                      ) : null}
                      <span
                        className={
                          isLast
                            ? "min-w-0 truncate"
                            : "shrink-0 text-muted-foreground"
                        }
                      >
                        {segment}
                      </span>
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
  const { data: projects } = useProjects()
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

  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)(?:\/|$)/)
  const projectThreadMatch = location.pathname.match(
    /^\/projects\/([^/]+)\/threads\/([^/]+)(?:\/|$)/
  )
  const threadMatch = projectThreadMatch
  const isProjectMainView = Boolean(projectMatch && !threadMatch)
  const threadId = projectThreadMatch?.[2] ?? ""

  const projectId = projectMatch?.[1]
  const projectName = projectId
    ? projects?.find((project) => project.id === projectId)?.name
    : undefined
  const { data: thread } = useThread(threadId)

  const meta = threadMatch
    ? {
        title: thread?.title ?? "Thread",
        subtitle: undefined,
      }
    : projectMatch
        ? {
            title: projectName ?? projectMatch[1],
            subtitle: undefined,
          }
        : (routeTitles[location.pathname] ?? { title: "" })

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
              projectName={projectName}
              meta={meta}
            />
          ) : null}
          <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
            {children}
          </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
