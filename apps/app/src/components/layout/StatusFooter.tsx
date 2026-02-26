import { Activity, Clock, Hash } from "lucide-react"
import { useSystemStatus } from "@/hooks/useApi"
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar"

export function StatusFooter() {
  const { data: status } = useSystemStatus()

  if (!status) return null

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="sm" className="cursor-default pointer-events-none text-muted-foreground">
            <Activity className="size-3.5" />
            <span>{status.runningThreads} active</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="sm" className="cursor-default pointer-events-none text-muted-foreground">
            <Clock className="size-3.5" />
            <span>{formatUptime(status.uptime)} uptime</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="sm" className="cursor-default pointer-events-none text-muted-foreground">
            <Hash className="size-3.5" />
            <span>{status.totalThreads} total</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  )
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}
