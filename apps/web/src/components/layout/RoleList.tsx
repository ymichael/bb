import { ContactRound } from "lucide-react"
import { useRoles } from "@/hooks/useApi"
import { NavLink } from "react-router-dom"
import { cn } from "@/lib/utils"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"

export function RoleList() {
  const { data: roles, isLoading } = useRoles()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Roles</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {isLoading ? (
            <SidebarMenuSkeleton />
          ) : roles && roles.length > 0 ? (
            roles.map((role) => (
              <SidebarMenuItem key={role.id}>
                <NavLink
                  to={`/roles/${encodeURIComponent(role.id)}`}
                  title={`${role.name} — ${role.description}`}
                  className={({ isActive }) =>
                    cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors",
                      isActive
                        ? "bg-sidebar-border/80 text-sidebar-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )
                  }
                >
                  <ContactRound className="size-3.5 shrink-0 text-sidebar-foreground/70" />
                  <span className="min-w-0 flex-1 truncate">{role.name}</span>
                </NavLink>
              </SidebarMenuItem>
            ))
          ) : (
            <SidebarMenuItem>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No roles</div>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
