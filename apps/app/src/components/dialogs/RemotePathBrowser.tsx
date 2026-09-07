import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { normalizeProjectPathInput } from "@bb/domain";
import type { HostDirectoryListing } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Input } from "@bb/shared-ui/input";
import { invalidateHostDirectoryListing } from "@/hooks/cache-owners/host-directory-cache-owner";
import { useHostDirectory } from "@/hooks/queries/host-queries";
import { sdk } from "@/lib/sdk";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@bb/shared-ui/lib/utils";

interface Crumb {
  label: string;
  path: string;
}

export function toBreadcrumb(directory: string): Crumb[] {
  const isWindows = /^[A-Za-z]:/.test(directory);
  if (!isWindows) {
    const crumbs: Crumb[] = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const segment of directory.split("/").filter(Boolean)) {
      accumulated = `${accumulated}/${segment}`;
      crumbs.push({ label: segment, path: accumulated });
    }
    return crumbs;
  }

  const segments = directory.replace(/\//g, "\\").split("\\").filter(Boolean);
  const drive = segments[0] ?? "";
  const crumbs: Crumb[] = [{ label: drive, path: `${drive}\\` }];
  let accumulated = drive;
  for (const segment of segments.slice(1)) {
    accumulated = `${accumulated}\\${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}

export function joinHostPath(directory: string, name: string): string {
  if (/^[A-Za-z]:/.test(directory)) {
    return `${directory.replace(/[\\/]+$/, "")}\\${name}`;
  }
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function getFolderNameValidationMessage(name: string): string | null {
  if (!name) return "Enter a folder name.";
  if (name === "." || name === "..") return "Enter a folder name.";
  if (/[\\/]/.test(name)) return "Folder names can't contain slashes.";
  return null;
}

const DIRECTORY_ENTRY_ROW_HEIGHT_PX = 28;
const DIRECTORY_ENTRY_OVERSCAN_ROWS = 10;

const NO_ENTRIES: HostDirectoryListing["entries"] = [];

interface RemotePathBrowserProps {
  hostId: string;
  initialPath?: string | null;
  allowCreateFolder: boolean;
  onDirectoryChange: (directory: string | null) => void;
  disabled?: boolean;
}

export function RemotePathBrowser({
  hostId,
  initialPath = null,
  allowCreateFolder,
  onDirectoryChange,
  disabled = false,
}: RemotePathBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const queryClient = useQueryClient();
  const { data, isError, error, isPlaceholderData } = useHostDirectory(
    hostId,
    currentPath,
  );

  const directory = data?.directory ?? null;
  const crumbs = directory ? toBreadcrumb(directory) : [];

  const entries = data?.entries ?? NO_ENTRIES;
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DIRECTORY_ENTRY_ROW_HEIGHT_PX,
    getItemKey: (index) => entries[index]?.path ?? index,
    overscan: DIRECTORY_ENTRY_OVERSCAN_ROWS,
  });

  const startCreatingFolder = () => {
    if (
      !allowCreateFolder ||
      disabled ||
      createFolder.isPending ||
      !directory ||
      isError ||
      isPlaceholderData
    ) {
      return;
    }
    setNewFolderName("");
    setNewFolderError(null);
    setIsCreatingFolder(true);
  };

  const cancelCreatingFolder = () => {
    setIsCreatingFolder(false);
    setNewFolderError(null);
  };

  const navigateTo = (path: string) => {
    cancelCreatingFolder();
    setCurrentPath(path);
  };

  const createFolder = useMutation({
    mutationFn: async ({ parent, name }: { parent: string; name: string }) => {
      const path = joinHostPath(parent, name);
      await sdk.files.mkdir({ hostId, path });
      return path;
    },
    onSuccess: async (path, { parent }) => {
      setNewFolderName("");
      navigateTo(path);
      await invalidateHostDirectoryListing({
        queryClient,
        hostId,
        directory: parent,
      });
    },
    onError: (mutationError) => {
      setNewFolderError(
        getMutationErrorMessage({
          error: mutationError,
          fallbackMessage: "Couldn't create that folder.",
        }),
      );
    },
  });

  const commitNewFolder = () => {
    if (
      disabled ||
      createFolder.isPending ||
      !directory ||
      isError ||
      isPlaceholderData
    ) {
      return;
    }
    const name = newFolderName.trim();
    const message = getFolderNameValidationMessage(name);
    if (message) {
      setNewFolderError(message);
      return;
    }
    setNewFolderError(null);
    createFolder.mutate({ parent: directory, name });
  };

  useEffect(() => {
    onDirectoryChange(directory);
  }, [directory, onDirectoryChange]);

  useEffect(() => {
    if (isEditing && !isPointerCoarse) editInputRef.current?.focus();
  }, [isEditing, isPointerCoarse]);

  useEffect(() => {
    if (isCreatingFolder && !isPointerCoarse)
      newFolderInputRef.current?.focus();
  }, [isCreatingFolder, isPointerCoarse]);

  const openEditor = () => {
    cancelCreatingFolder();
    setEditValue(directory ?? "");
    setIsEditing(true);
  };

  const commitEditor = () => {
    const normalized = normalizeProjectPathInput(editValue);
    setIsEditing(false);
    if (normalized) navigateTo(normalized);
  };

  const interactionDisabled = disabled || createFolder.isPending;
  const canCreateFolderHere =
    allowCreateFolder &&
    !interactionDisabled &&
    directory !== null &&
    !isError &&
    !isPlaceholderData;

  let body: ReactNode;
  if (isError) {
    body = (
      <EmptyState
        icon="AlertCircle"
        message={getMutationErrorMessage({
          error,
          fallbackMessage: "Couldn't read this folder.",
        })}
        messageClassName="text-destructive"
        className="px-2 py-3"
      />
    );
  } else if (!data) {
    body = (
      <EmptyState
        icon="Spinner"
        iconClassName="animate-spin"
        message="Loading…"
        className="px-2 py-3"
      />
    );
  } else if (entries.length === 0) {
    body = <EmptyState message="This folder is empty." className="px-2 py-3" />;
  } else {
    body = (
      <ul
        className="relative"
        style={{ height: entryVirtualizer.getTotalSize() }}
      >
        {entryVirtualizer.getVirtualItems().map((virtualItem) => {
          const entry = entries[virtualItem.index];
          if (!entry) return null;
          if (entry.kind === "file") {
            return (
              <li
                key={entry.path}
                data-index={virtualItem.index}
                ref={entryVirtualizer.measureElement}
                className="absolute left-0 flex w-full items-center gap-2 px-2 py-1 text-sm text-muted-foreground"
                style={{ top: virtualItem.start }}
              >
                <Icon name="File" className="size-4 shrink-0" />
                <span className="min-w-0 truncate" title={entry.name}>
                  {entry.name}
                </span>
              </li>
            );
          }
          return (
            <li
              key={entry.path}
              data-index={virtualItem.index}
              ref={entryVirtualizer.measureElement}
              className="absolute left-0 w-full"
              style={{ top: virtualItem.start }}
            >
              <button
                type="button"
                disabled={interactionDisabled}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted disabled:pointer-events-none"
                onClick={() => navigateTo(entry.path)}
              >
                <Icon
                  name="Folder"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate" title={entry.name}>
                  {entry.name}
                </span>
                <Icon
                  name="ChevronRight"
                  className="ml-auto size-4 shrink-0 text-muted-foreground"
                />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex flex-col rounded-md border">
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        {isEditing ? (
          <>
            <Input
              ref={editInputRef}
              aria-label="Project path"
              className="h-7 flex-1 text-xs"
              value={editValue}
              disabled={disabled}
              placeholder="/path/to/project"
              onChange={(event) => setEditValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitEditor();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setIsEditing(false);
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="Go to path"
              disabled={disabled}
              onClick={commitEditor}
            >
              <Icon name="Check" />
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="Go to parent folder"
              disabled={interactionDisabled || !data?.parent}
              onClick={() => {
                if (data?.parent) navigateTo(data.parent);
              }}
            >
              <Icon name="ArrowUp" />
            </Button>
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex items-center">
                  {index > 0 ? (
                    <Icon
                      name="ChevronRight"
                      className="size-3 shrink-0 opacity-50"
                    />
                  ) : null}
                  <button
                    type="button"
                    disabled={interactionDisabled}
                    className={cn(
                      "rounded px-1 py-0.5 hover:bg-muted hover:text-foreground",
                      index === crumbs.length - 1 &&
                        "font-medium text-foreground",
                    )}
                    onClick={() => navigateTo(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
            {allowCreateFolder ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="New folder"
                disabled={!canCreateFolderHere}
                onClick={startCreatingFolder}
              >
                <Icon name="FolderPlus" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="Edit path"
              disabled={interactionDisabled}
              onClick={openEditor}
            >
              <Icon name="Edit" />
            </Button>
          </>
        )}
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "h-56 min-h-0 overflow-y-auto px-1.5 py-1",
          isPlaceholderData && "opacity-60",
        )}
      >
        {isCreatingFolder ? (
          <div
            role="group"
            aria-label="Create new folder"
            className="mb-1 flex flex-col gap-1"
          >
            {}
            <div className="flex items-center gap-2 px-2">
              <Icon
                name="Folder"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <Input
                ref={newFolderInputRef}
                aria-label="New folder name"
                className="-ml-1 h-7 min-w-0 flex-1 px-1 text-sm"
                value={newFolderName}
                disabled={interactionDisabled}
                placeholder="Folder name"
                onChange={(event) => {
                  setNewFolderName(event.target.value);
                  setNewFolderError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitNewFolder();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelCreatingFolder();
                  }
                }}
              />
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label="Create folder"
                  disabled={interactionDisabled}
                  onClick={commitNewFolder}
                >
                  <Icon
                    name={createFolder.isPending ? "Spinner" : "Check"}
                    className={cn(createFolder.isPending && "animate-spin")}
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label="Cancel new folder"
                  disabled={interactionDisabled}
                  onClick={cancelCreatingFolder}
                >
                  <Icon name="X" />
                </Button>
              </div>
            </div>
            {newFolderError ? (
              <p role="alert" className="px-2 text-xs text-destructive">
                {newFolderError}
              </p>
            ) : null}
          </div>
        ) : null}
        {body}
      </div>
    </div>
  );
}
