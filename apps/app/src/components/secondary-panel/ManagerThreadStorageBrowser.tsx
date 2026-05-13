import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { FileTree } from "@pierre/trees/react";
import { Button, EmptyState, Icon, Input } from "@/components/ui";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { ManagerStorageBrowserController } from "./useManagerStorageBrowser";

interface FileTreeHostStyle extends CSSProperties {
  "--trees-accent-override": string;
  "--trees-bg-muted-override": string;
  "--trees-bg-override": string;
  "--trees-border-color-override": string;
  "--trees-fg-muted-override": string;
  "--trees-fg-override": string;
  "--trees-focus-ring-color-override": string;
  "--trees-font-family-override": string;
  "--trees-font-size-override": string;
  "--trees-item-margin-x-override": string;
  "--trees-padding-inline-override": string;
  "--trees-scrollbar-thumb-override": string;
  "--trees-selected-bg-override": string;
  "--trees-selected-fg-override": string;
  "--trees-selected-focused-border-color-override": string;
}

const FILE_TREE_BASE_HOST_STYLE: FileTreeHostStyle = {
  "--trees-accent-override": "var(--ring)",
  "--trees-bg-muted-override":
    "color-mix(in srgb, var(--muted) 45%, transparent)",
  "--trees-bg-override": "transparent",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "var(--text-sm)",
  "--trees-item-margin-x-override": "0",
  "--trees-padding-inline-override": "0",
  "--trees-scrollbar-thumb-override":
    "color-mix(in srgb, var(--muted-foreground) 35%, transparent)",
  "--trees-selected-bg-override":
    "color-mix(in srgb, var(--accent) 65%, transparent)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  height: "100%",
};

interface ManagerThreadStorageBrowserProps {
  controller: ManagerStorageBrowserController;
  filesError?: Error | null;
  isFilesLoading: boolean;
}

export function ManagerThreadStorageBrowser({
  controller,
  filesError,
  isFilesLoading,
}: ManagerThreadStorageBrowserProps) {
  const {
    closeSearch,
    filteredFiles,
    isSearchOpen,
    loadedFiles,
    model,
    searchQuery,
    setSearchQuery,
  } = controller;
  const preferredTheme = usePreferredTheme();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [isSearchOpen]);

  const fileTreeHostStyle = useMemo<FileTreeHostStyle>(
    () => ({
      ...FILE_TREE_BASE_HOST_STYLE,
      colorScheme: preferredTheme,
    }),
    [preferredTheme],
  );

  let body: ReactNode;
  if (filesError) {
    body = (
      <EmptyState
        message={filesError.message}
        messageClassName="text-destructive"
      />
    );
  } else if (isFilesLoading && loadedFiles.length === 0) {
    body = (
      <EmptyState
        icon="Spinner"
        message="Loading files..."
        iconClassName="animate-spin"
      />
    );
  } else if (loadedFiles.length === 0) {
    body = <EmptyState message="No files yet." />;
  } else if (filteredFiles.length === 0) {
    body = <EmptyState message="No files match search." />;
  } else {
    body = (
      <FileTree
        aria-label="Thread storage file tree"
        className="block h-full min-h-0"
        model={model}
        style={fileTreeHostStyle}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {isSearchOpen ? (
        <div className="flex h-7 shrink-0 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              aria-label="Search files"
              className="h-7 pl-7 pr-2 text-xs"
              placeholder="Search files"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground"
            aria-label="Close search"
            onClick={closeSearch}
          >
            <Icon name="X" className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
