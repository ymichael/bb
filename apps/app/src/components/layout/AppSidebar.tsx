import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { useLocation } from "react-router-dom"
import { Bug, BugOff, Moon, Sun } from "lucide-react"
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
import { useDebugMode } from "@/hooks/useDebugMode"

const THEME_STORAGE_KEY = "beanbag.theme"

type Theme = "light" | "dark"

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
  isResizing: boolean
}

export function AppSidebar({ onResizeMouseDown, isResizing }: AppSidebarProps) {
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const { createFromPicker, isCreating } = useQuickCreateProject()
  const { debugMode, toggleDebugMode } = useDebugMode()
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light"
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme
    if (document.documentElement.classList.contains("dark")) return "dark"
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  })

  const closeOnMobile = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const isDarkTheme = theme === "dark"
  const toggleTheme = () => {
    setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))
  }
  const selectedProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1]

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
                onClick={toggleDebugMode}
                className="w-8 justify-center p-0"
                tooltip={debugMode ? "Disable debug mode" : "Enable debug mode"}
                aria-label={debugMode ? "Disable debug mode" : "Enable debug mode"}
              >
                {debugMode ? <BugOff /> : <Bug />}
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
