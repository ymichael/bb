import { MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ThreadActionsMenuProps {
  onToggleRead: () => void
  onRename: () => void
  onToggleArchive: () => void
  isRead: boolean
  isArchived: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  triggerClassName?: string
  align?: "start" | "center" | "end"
}

export function ThreadActionsMenu({
  onToggleRead,
  onRename,
  onToggleArchive,
  isRead,
  isArchived,
  onOpenChange,
  disabled = false,
  triggerClassName,
  align = "end",
}: ThreadActionsMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "data-[state=open]:bg-accent data-[state=open]:text-foreground",
            triggerClassName
          )}
          aria-label="Thread actions"
          title="Thread actions"
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <DropdownMenuItem
          disabled={disabled}
          onSelect={(event) => {
            event.preventDefault()
            onToggleRead()
          }}
        >
          {isRead ? "Mark as unread" : "Mark as read"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={(event) => {
            event.preventDefault()
            onRename()
          }}
        >
          Rename thread
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={(event) => {
            event.preventDefault()
            onToggleArchive()
          }}
        >
          {isArchived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
