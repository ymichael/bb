import {
  isLocalPathProjectSource,
  type LocalPathProjectSource,
  type ProjectSource,
} from "@bb/domain";
import { Icon } from "@/components/ui/icon.js";
import { LocalhostBadge } from "@/components/ui/localhost-badge.js";
import { SettingsRow } from "@/components/ui/settings-section.js";
import { StatusPill } from "@/components/ui/status-pill.js";
import { GitHubIcon } from "@/components/icons/GitHubIcon";
import { PersistentHostIconName } from "@/lib/host-display";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";

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
        <Icon
          name={PersistentHostIconName}
          className="size-4 shrink-0 text-muted-foreground"
        />
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
            className="h-7 w-7 shrink-0"
            aria-label="Source actions"
          >
            <Icon name="MoreHorizontal" className="size-4" />
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
              Edit local path
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={isOnlySource}
            onSelect={() => onRemove(source)}
          >
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
