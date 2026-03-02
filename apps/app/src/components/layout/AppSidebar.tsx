import type { ThreadStatus } from "@beanbag/agent-core"
import { cn } from "@/lib/utils"
import { Link, useLocation } from "react-router-dom"
import { Moon, RotateCcw, Settings, Sun } from "lucide-react"
import { toast } from "sonner"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ProjectList } from "./ProjectList"
import { useQuickCreateProject } from "@/hooks/useQuickCreateProject"
import {
  useShutdownDaemon,
  useSystemRestartPolicy,
  useThreads,
} from "@/hooks/useApi"
import { useDaemonConnectionState } from "@/hooks/useDaemonConnectionState"
import { setPreferredTheme, usePreferredTheme } from "@/hooks/useTheme"

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
  isResizing: boolean
}

const DEFAULT_SHUTDOWN_BLOCKING_STATUSES: readonly ThreadStatus[] = [
  "created",
  "provisioning",
  "active",
]

export function AppSidebar({ onResizeMouseDown, isResizing }: AppSidebarProps) {
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const { createFromPicker, isCreating } = useQuickCreateProject()
  const { data: threads } = useThreads()
  const { data: restartPolicy } = useSystemRestartPolicy()
  const shutdownDaemon = useShutdownDaemon()
  const daemonConnectionState = useDaemonConnectionState()
  const theme = usePreferredTheme()

  const closeOnMobile = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const isDarkTheme = theme === "dark"
  const toggleTheme = () => {
    setPreferredTheme(isDarkTheme ? "light" : "dark")
  }
  const selectedProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1]
  const shutdownBlockingStatuses =
    restartPolicy?.shutdownBlockingStatuses ?? DEFAULT_SHUTDOWN_BLOCKING_STATUSES
  const blockingThreadCount =
    threads?.filter((thread) => shutdownBlockingStatuses.includes(thread.status)).length ??
    0
  const cannotRestart = blockingThreadCount > 0
  const isRestartDisabled = cannotRestart || shutdownDaemon.isPending
  const shouldRestart = daemonConnectionState === "disconnected"

  const restartTooltip = shutdownDaemon.isPending
    ? "Requesting daemon restart…"
    : cannotRestart
      ? `Cannot restart while ${blockingThreadCount} thread${blockingThreadCount === 1 ? "" : "s"} ${blockingThreadCount === 1 ? "is" : "are"} active`
      : shouldRestart
        ? "Daemon disconnected. Restart recommended"
        : "Restart daemon"

  const requestRestart = () => {
    if (isRestartDisabled) return
    shutdownDaemon.mutate({}, {
      onSuccess: () => {
        toast.success("Daemon restart requested")
      },
      onError: (error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to request daemon restart",
        )
      },
    })
  }

  return (
    <>
      <Sidebar>
        <SidebarContent>
          <ProjectList
            onNewProject={() => {
              void createFromPicker()
            }}
            onProjectSelect={closeOnMobile}
            selectedProjectId={selectedProjectId}
            isCreatingProject={isCreating}
          />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu className="flex-row">
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={toggleTheme}
                className="w-8 justify-center p-0"
                tooltip={isDarkTheme ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={isDarkTheme ? "Switch to light mode" : "Switch to dark mode"}
              >
                {isDarkTheme ? <Sun /> : <Moon />}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={requestRestart}
                disabled={isRestartDisabled}
                className="w-8 justify-center p-0"
                tooltip={restartTooltip}
                aria-label={restartTooltip}
              >
                <RotateCcw className={cn(shutdownDaemon.isPending && "animate-spin")} />
              </SidebarMenuButton>
              {shouldRestart ? (
                <span
                  className="pointer-events-none absolute right-1 top-1 inline-flex size-2 rounded-full bg-destructive"
                  aria-hidden
                />
              ) : null}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="w-8 justify-center p-0"
                tooltip="App settings"
                aria-label="App settings"
              >
                <Link to="/settings">
                  <Settings />
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <div
          className={cn(
            "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
            "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-border",
            "group-data-[collapsible=icon]:hidden",
            isResizing && "before:bg-sidebar-border"
          )}
          onMouseDown={onResizeMouseDown}
        />
      </Sidebar>
    </>
  )
}
