import { useEffect, useId, useState, type FormEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
  type Host,
} from "@bb/domain";
import type { HostPlatform } from "@bb/host-daemon-contract";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { RemotePathBrowser } from "@/components/dialogs/RemotePathBrowser";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";

export type ProjectPathDialogTarget =
  | {
      kind: "create";
    }
  | {
      kind: "update";
      projectId: string;
      projectName: string;
      currentPath: string;
    }
  | {
      kind: "add-source";
      projectId: string;
      projectName: string;
    };

export type ProjectPathDialogSubmitHandler = (
  target: ProjectPathDialogTarget,
  path: string,
  hostId: string | null,
) => Promise<void> | void;

interface ProjectPathDialogProps {
  target: ProjectPathDialogTarget | null;
  pending?: boolean;
  platform: HostPlatform | null;
  hostId: string | null;
  hostName: string | null;
  hosts?: readonly Host[];
  onOpenChange: (open: boolean) => void;
  onSubmit: ProjectPathDialogSubmitHandler;
}

export function ProjectPathDialog({
  target,
  pending = false,
  platform,
  hostId,
  hostName,
  hosts,
  onOpenChange,
  onSubmit,
}: ProjectPathDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ProjectPathDialogContent
            key={target.kind === "create" ? "create" : target.projectId}
            target={target}
            pending={pending}
            platform={platform}
            hostId={hostId}
            hostName={hostName}
            hosts={hosts}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ProjectPathDialogContentProps {
  target: ProjectPathDialogTarget;
  pending: boolean;
  platform: HostPlatform | null;
  hostId: string | null;
  hostName: string | null;
  hosts?: readonly Host[];
  onSubmit: ProjectPathDialogSubmitHandler;
}

interface PlatformCopy {
  description: string;
  placeholder: string;
}

function getDialogTitle(kind: ProjectPathDialogTarget["kind"]): string {
  switch (kind) {
    case "create":
      return "Add project";
    case "update":
      return "Update project path";
    case "add-source":
      return "Add project source";
  }
}

function getDialogSubmitLabel(kind: ProjectPathDialogTarget["kind"]): string {
  switch (kind) {
    case "create":
      return "Add project";
    case "update":
      return "Save path";
    case "add-source":
      return "Add source";
  }
}

function getPlatformCopy(
  platform: HostPlatform | null,
  hostName: string | null,
): PlatformCopy {
  const placeholder = "/path/to/project";
  const hostSuffix = hostName ? ` on ${hostName}` : "";
  if (platform === "wsl") {
    return {
      description: `Enter an absolute WSL path${hostSuffix} to the project folder, such as /home/me/repo or /mnt/c/...`,
      placeholder,
    };
  }
  return {
    description: `Enter an absolute path${hostSuffix} to the project folder.`,
    placeholder,
  };
}

export function ProjectPathDialogContent({
  target,
  pending,
  platform,
  hostId,
  hostName,
  hosts,
  onSubmit,
}: ProjectPathDialogContentProps) {
  const inputId = useId();
  const isPointerCoarse = usePointerCoarse();
  const machineOptions = target.kind === "create" ? hosts : undefined;
  const firstConnectedHostId = machineOptions?.find(
    (host) => host.status === "connected",
  )?.id;
  const initialHostId =
    hostId !== null &&
    (machineOptions === undefined ||
      machineOptions.some(
        (host) => host.id === hostId && host.status === "connected",
      ))
      ? hostId
      : (firstConnectedHostId ?? hostId);
  const [selectedHostId, setSelectedHostId] = useState(initialHostId);
  const selectedHost = machineOptions?.find(
    (host) => host.id === selectedHostId,
  );
  const selectedHostName = selectedHost?.name ?? hostName;
  const selectedHostConnected =
    selectedHost === undefined || selectedHost.status === "connected";
  const showMachinePicker = (machineOptions?.length ?? 0) > 1;
  const noMachineAvailable = showMachinePicker && selectedHostId === null;
  const [manualPath, setManualPath] = useState(
    target.kind === "update" ? target.currentPath : "",
  );
  const [browserDirectory, setBrowserDirectory] = useState<string | null>(
    target.kind === "update" ? target.currentPath : null,
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const copy = getPlatformCopy(platform, selectedHostName);
  const placeholder =
    target.kind === "update"
      ? target.currentPath || copy.placeholder
      : copy.placeholder;

  const selectedPath = selectedHostId
    ? browserDirectory
    : normalizeProjectPathInput(manualPath) || null;
  const derivedProjectName = selectedPath
    ? deriveProjectNameFromPath(selectedPath)
    : "";

  useEffect(() => {
    setValidationMessage(null);
  }, [selectedPath]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    if (!selectedPath) {
      setValidationMessage("Choose a project folder.");
      return;
    }

    const normalizedPath = normalizeProjectPathInput(selectedPath);
    const pathValidationMessage =
      getProjectPathValidationMessage(normalizedPath);
    if (pathValidationMessage) {
      setValidationMessage(pathValidationMessage);
      return;
    }

    if (
      target.kind === "create" &&
      !deriveProjectNameFromPath(normalizedPath)
    ) {
      setValidationMessage("Could not derive a project name from that path.");
      return;
    }

    void onSubmit(target, normalizedPath, selectedHostId);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{getDialogTitle(target.kind)}</DialogTitle>
        <DialogDescription>
          {selectedHostId
            ? `Browse to the project folder${
                selectedHostName ? ` on ${selectedHostName}` : ""
              }, or edit the path directly.`
            : noMachineAvailable
              ? "No machine is online. Start one to choose a project folder."
              : copy.description}
        </DialogDescription>
      </DialogHeader>
      <form className="min-w-0 space-y-4" onSubmit={handleSubmit}>
        {showMachinePicker ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={pending}>
              <Button
                type="button"
                variant="outline"
                aria-label="Machine"
                disabled={pending}
                className="w-full justify-between font-normal"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {selectedHost ? (
                    <MachineStatusDot connected={selectedHostConnected} />
                  ) : null}
                  <span className="min-w-0 truncate">
                    {selectedHost?.name ?? "Select a machine"}
                  </span>
                </span>
                <Icon
                  name="ChevronDown"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              mobileTitle="Machine"
              className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
            >
              {machineOptions?.map((host) => {
                const connected = host.status === "connected";
                return (
                  <DropdownMenuItem
                    key={host.id}
                    disabled={!connected}
                    className="flex items-center gap-2"
                    onSelect={() => {
                      if (!connected) return;
                      setSelectedHostId(host.id);
                      setBrowserDirectory(null);
                    }}
                  >
                    <MachineStatusDot connected={connected} />
                    <span className="min-w-0 flex-1 truncate">{host.name}</span>
                    {!connected ? (
                      <span className="shrink-0 text-xs text-subtle-foreground">
                        Offline
                      </span>
                    ) : null}
                    <Icon
                      name="Check"
                      className={cn(
                        "size-4 shrink-0",
                        host.id === selectedHostId
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {selectedHostId ? (
          <RemotePathBrowser
            key={selectedHostId}
            hostId={selectedHostId}
            initialPath={target.kind === "update" ? target.currentPath : null}
            allowCreateFolder={target.kind === "create"}
            onDirectoryChange={setBrowserDirectory}
            disabled={pending || !selectedHostConnected}
          />
        ) : noMachineAvailable ? (
          <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
            Every machine is offline. Bring one online to browse its folders.
          </p>
        ) : (
          <Input
            id={inputId}
            aria-label="Project path"
            value={manualPath}
            autoFocus={!isPointerCoarse}
            disabled={pending}
            placeholder={placeholder}
            onChange={(event) => {
              setManualPath(event.target.value);
            }}
          />
        )}
        {(derivedProjectName && target.kind === "create") ||
        validationMessage ? (
          <div className="space-y-1">
            {target.kind === "create" && derivedProjectName ? (
              <p className="flex min-w-0 gap-1 text-sm text-muted-foreground">
                <span className="shrink-0">Project name:</span>
                <span className="min-w-0 truncate font-medium text-foreground">
                  {derivedProjectName}
                </span>
              </p>
            ) : null}
            {validationMessage ? (
              <p className="text-sm text-destructive">{validationMessage}</p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="submit"
            disabled={
              pending ||
              !selectedPath ||
              !selectedHostConnected ||
              noMachineAvailable
            }
          >
            {getDialogSubmitLabel(target.kind)}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
