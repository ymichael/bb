import { type LocalPathProjectSource, type ProjectSource } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { SettingsRow } from "@/components/ui/settings-section.js";
import { Pill } from "@bb/shared-ui/pill";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { PersistentHostIconName } from "@/lib/host-display";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";

interface ProjectSourceRowMachine {
  name: string;
  connected: boolean;
}

interface ProjectSourceRowProps {
  source: ProjectSource;
  machine: ProjectSourceRowMachine | null;
  canEditLocalPath: boolean;
  isLocalPathInvalid: boolean;
  isEditPending: boolean;
  isOnlySource: boolean;
  onEditLocalPath: (source: LocalPathProjectSource) => void;
  onRemove: (source: ProjectSource) => void;
}

export function ProjectSourceRow({
  source,
  machine,
  canEditLocalPath,
  isLocalPathInvalid,
  isEditPending,
  isOnlySource,
  onEditLocalPath,
  onRemove,
}: ProjectSourceRowProps) {
  const isOffline = machine !== null && !machine.connected;
  return (
    <SettingsRow>
      <Icon
        name={PersistentHostIconName}
        className={cn(
          "size-4 shrink-0 text-muted-foreground",
          isOffline && "opacity-60",
        )}
      />
      <span
        className={cn(
          "flex min-w-0 flex-1 items-baseline gap-1.5",
          isOffline && "opacity-60",
        )}
      >
        {machine !== null ? (
          <span className="flex shrink-0 items-baseline gap-1.5">
            <MachineStatusDot
              connected={machine.connected}
              className="self-center"
            />
            <span className="max-w-40 truncate font-medium">
              {machine.name}
            </span>
          </span>
        ) : null}
        <span className="min-w-0 flex-shrink truncate">{source.path}</span>
        {isLocalPathInvalid ? (
          <Pill variant="destructive">Invalid local path</Pill>
        ) : null}
        {isOffline ? (
          <span className="shrink-0 text-xs text-subtle-foreground">
            offline
          </span>
        ) : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 data-[state=open]:bg-state-active data-[state=open]:text-foreground"
            aria-label="Source actions"
          >
            <Icon name="MoreHorizontal" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {canEditLocalPath ? (
            <DropdownMenuItem
              disabled={isEditPending}
              onSelect={() => {
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
