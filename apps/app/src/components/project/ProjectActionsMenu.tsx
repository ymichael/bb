import { Icon } from "@bb/shared-ui/icon";
import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@/components/ui/action-menu-items";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import type { MouseEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";

import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { CompactLongPressMenu } from "@/components/ui/compact-long-press-menu";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { getProjectSettingsRoutePath } from "@/lib/route-paths";
import { cn } from "@bb/shared-ui/lib/utils";
import { useProjectActions } from "./ProjectActionsProvider";

interface ProjectActionsMenuBaseProps {
  project: ProjectResponse;
}

interface ProjectActionsMenuProps extends ProjectActionsMenuBaseProps {
  triggerClassName?: string;
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

function stopProjectActionsMenuClickPropagation(event: MouseEvent) {
  event.stopPropagation();
}

function ProjectActionsMenuItems({
  project,
  surface,
}: ProjectActionsMenuItemsProps) {
  const navigate = useNavigate();
  const { hostId: pickerHostId } = usePathPickerHost();
  const { requestRename, requestDelete, requestAddLocalPath } =
    useProjectActions();
  const showAddLocalPath =
    pickerHostId != null &&
    !findLocalPathProjectSourceForHost(project.sources, pickerHostId);

  return (
    <>
      <ActionMenuItem
        surface={surface}
        icon="Settings"
        onSelect={() => {
          navigate(getProjectSettingsRoutePath(project.id));
        }}
      >
        Project settings
      </ActionMenuItem>
      <ActionMenuSeparator surface={surface} />
      <ActionMenuItem
        surface={surface}
        icon="Edit"
        onSelect={() => {
          requestRename(project);
        }}
      >
        Rename
      </ActionMenuItem>
      {showAddLocalPath ? (
        <ActionMenuItem
          surface={surface}
          icon="FolderPlus"
          onSelect={() => {
            requestAddLocalPath(project);
          }}
        >
          Add local path
        </ActionMenuItem>
      ) : null}
      <ActionMenuItem
        surface={surface}
        icon="Trash2"
        variant="destructive"
        onSelect={() => {
          requestDelete(project);
        }}
      >
        Remove
      </ActionMenuItem>
    </>
  );
}

export function ProjectActionsMenu({
  project,
  triggerClassName,
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
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
          aria-label={`${project.name} actions`}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={stopProjectActionsMenuClickPropagation}
      >
        <ProjectActionsMenuItems project={project} surface="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectActionsContextMenu(
  props: ProjectActionsContextMenuProps,
) {
  const isCompactViewport = useIsCompactViewport();
  if (isCompactViewport) {
    return <ProjectActionsCompactLongPressMenu {...props} />;
  }
  return <ProjectActionsDesktopContextMenu {...props} />;
}

function ProjectActionsCompactLongPressMenu({
  children,
  project,
  onOpenChange,
}: ProjectActionsContextMenuProps) {
  return (
    <CompactLongPressMenu
      label={`${project.name} actions`}
      onOpenChange={onOpenChange}
      items={<ProjectActionsMenuItems project={project} surface="dropdown" />}
    >
      {children}
    </CompactLongPressMenu>
  );
}

function ProjectActionsDesktopContextMenu({
  children,
  project,
  onOpenChange,
}: ProjectActionsContextMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${project.name} actions`}
        onClick={stopProjectActionsMenuClickPropagation}
      >
        <ProjectActionsMenuItems project={project} surface="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
