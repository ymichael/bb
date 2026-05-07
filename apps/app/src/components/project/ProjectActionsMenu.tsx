import { FolderPlus, MoreHorizontal, PencilLine, Trash2 } from "lucide-react";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { Button } from "@/components/ui";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { cn } from "@/lib/utils";
import { useProjectActions } from "./ProjectActionsProvider";

interface ProjectActionsMenuProps {
  project: ProjectResponse;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
  onOpenChange?: (open: boolean) => void;
}

export function ProjectActionsMenu({
  project,
  triggerClassName,
  align = "end",
  onOpenChange,
}: ProjectActionsMenuProps) {
  const { localHostId } = useHostDaemon();
  const { requestRename, requestDelete, requestAddLocalPath } =
    useProjectActions();
  const showAddLocalPath =
    localHostId != null &&
    !findLocalPathProjectSourceForHost(project.sources, localHostId);

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0 text-muted-foreground hover:bg-accent/45 hover:text-foreground data-[state=open]:bg-accent/35 data-[state=open]:text-foreground",
            triggerClassName,
          )}
          aria-label={`${project.name} actions`}
          title={`${project.name} actions`}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <MoreHorizontal className={COARSE_POINTER_ICON_SIZE_CLASS} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            requestRename(project);
          }}
        >
          <PencilLine className="size-4" />
          Rename
        </DropdownMenuItem>
        {showAddLocalPath ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              requestAddLocalPath(project);
            }}
          >
            <FolderPlus className="size-4" />
            Add local path
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={(event) => {
            event.preventDefault();
            requestDelete(project);
          }}
        >
          <Trash2 className="size-4" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
