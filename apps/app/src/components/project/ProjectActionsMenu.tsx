import { FolderPlus, MoreHorizontal, PencilLine, Trash2 } from "lucide-react";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { cn } from "@/lib/utils";
import { useProjectActions } from "./ProjectActionsProvider";

interface ProjectActionsMenuBaseProps {
  project: ProjectResponse;
}

interface ProjectActionsMenuProps extends ProjectActionsMenuBaseProps {
  triggerClassName?: string;
  align?: "start" | "center" | "end";
  onOpenChange?: (open: boolean) => void;
}

interface ProjectActionsContextMenuProps extends ProjectActionsMenuBaseProps {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

type ProjectActionsMenuSurface = "context" | "dropdown";

interface ProjectActionsMenuItemsProps extends ProjectActionsMenuBaseProps {
  surface: ProjectActionsMenuSurface;
}

interface ProjectActionMenuItemProps {
  children: ReactNode;
  className?: string;
  onSelect?: (event: Event) => void;
  surface: ProjectActionsMenuSurface;
}

function ProjectActionMenuItem({
  children,
  className,
  onSelect,
  surface,
}: ProjectActionMenuItemProps) {
  if (surface === "context") {
    return (
      <ContextMenuItem className={className} onSelect={onSelect}>
        {children}
      </ContextMenuItem>
    );
  }

  return (
    <DropdownMenuItem className={className} onSelect={onSelect}>
      {children}
    </DropdownMenuItem>
  );
}

function ProjectActionsMenuItems({
  project,
  surface,
}: ProjectActionsMenuItemsProps) {
  const { localHostId } = useHostDaemon();
  const { requestRename, requestDelete, requestAddLocalPath } =
    useProjectActions();
  const showAddLocalPath =
    localHostId != null &&
    !findLocalPathProjectSourceForHost(project.sources, localHostId);

  return (
    <>
      <ProjectActionMenuItem
        surface={surface}
        onSelect={(event) => {
          if (surface === "dropdown") {
            event.preventDefault();
          }
          requestRename(project);
        }}
      >
        <PencilLine className="size-4" />
        Rename
      </ProjectActionMenuItem>
      {showAddLocalPath ? (
        <ProjectActionMenuItem
          surface={surface}
          onSelect={(event) => {
            if (surface === "dropdown") {
              event.preventDefault();
            }
            requestAddLocalPath(project);
          }}
        >
          <FolderPlus className="size-4" />
          Add local path
        </ProjectActionMenuItem>
      ) : null}
      <ProjectActionMenuItem
        surface={surface}
        className="text-destructive focus:text-destructive"
        onSelect={(event) => {
          if (surface === "dropdown") {
            event.preventDefault();
          }
          requestDelete(project);
        }}
      >
        <Trash2 className="size-4" />
        Remove
      </ProjectActionMenuItem>
    </>
  );
}

export function ProjectActionsMenu({
  project,
  triggerClassName,
  align = "end",
  onOpenChange,
}: ProjectActionsMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0 text-muted-foreground",
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
        <ProjectActionsMenuItems project={project} surface="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectActionsContextMenu({
  children,
  project,
  onOpenChange,
}: ProjectActionsContextMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${project.name} actions`}
        className="w-44"
      >
        <ProjectActionsMenuItems project={project} surface="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
