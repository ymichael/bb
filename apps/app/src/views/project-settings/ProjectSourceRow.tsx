import { Monitor, MoreHorizontal, PencilLine, Trash2 } from "lucide-react";
import {
  isLocalPathProjectSource,
  type LocalPathProjectSource,
  type ProjectSource,
} from "@bb/domain";
import { LocalhostBadge, SettingsRow, StatusPill } from "@/components/ui";
import { GitHubIcon } from "@/components/icons/GitHubIcon";
import { Button } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";

interface ProjectSourceRowProps {
  source: ProjectSource;
  isLocalhostSource: boolean;
  isLocalPathInvalid: boolean;
  hostName: string;
  isEditPending: boolean;
  isOnlySource: boolean;
  onEditLocalPath: (source: LocalPathProjectSource) => void;
  onRemove: (source: ProjectSource) => void;
}

export function ProjectSourceRow({
  source,
  isLocalhostSource,
  isLocalPathInvalid,
  hostName,
  isEditPending,
  isOnlySource,
  onEditLocalPath,
  onRemove,
}: ProjectSourceRowProps) {
  const isLocalSource = isLocalPathProjectSource(source);

  return (
    <SettingsRow>
      {isLocalSource ? (
        <Monitor className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <GitHubIcon className="size-4 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 flex-shrink truncate">
          {isLocalSource ? source.path : source.repoUrl}
        </span>
        {isLocalSource ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {hostName}
          </span>
        ) : null}
        {isLocalhostSource ? (
          <span className="self-center">
            <LocalhostBadge />
          </span>
        ) : null}
        {isLocalPathInvalid ? (
          <StatusPill variant="destructive">Invalid local path</StatusPill>
        ) : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
            aria-label="Source actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {isLocalhostSource && isLocalSource ? (
            <DropdownMenuItem
              disabled={isEditPending}
              onSelect={(event) => {
                event.preventDefault();
                onEditLocalPath(source);
              }}
            >
              <PencilLine className="size-4" />
              Edit local path
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={isOnlySource}
            onSelect={() => onRemove(source)}
          >
            <Trash2 className="size-4" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
