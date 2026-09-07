import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  describeLifecycleError,
  formatLifecycleErrorDescription,
} from "@/lib/lifecycle-errors";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { LazyThreadStorageFileTree } from "./lazySecondaryPanelComponents";
import type { ThreadStorageBrowserController } from "./useThreadStorageBrowser";

interface ThreadStorageBrowserProps {
  controller: ThreadStorageBrowserController;
  filesError?: Error | null;
  isFilesLoading: boolean;
}

export function ThreadStorageBrowser({
  controller,
  filesError,
  isFilesLoading,
}: ThreadStorageBrowserProps) {
  const {
    closeSearch,
    filteredFiles,
    isSearchOpen,
    loadedFiles,
    model,
    searchQuery,
    setSearchQuery,
  } = controller;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isPointerCoarse = usePointerCoarse();

  useEffect(() => {
    if (isSearchOpen && !isPointerCoarse) {
      searchInputRef.current?.focus();
    }
  }, [isPointerCoarse, isSearchOpen]);

  const loadingState = (
    <EmptyState
      icon="Spinner"
      message="Loading files..."
      iconClassName="animate-spin"
    />
  );
  let body: ReactNode;
  if (filesError) {
    const lifecycleErrorDescription = describeLifecycleError({
      error: filesError,
      operation: "load_thread_storage",
    });
    body = (
      <EmptyState
        message={
          (lifecycleErrorDescription
            ? formatLifecycleErrorDescription(lifecycleErrorDescription)
            : null) ??
          getMutationErrorMessage({
            error: filesError,
            fallbackMessage: "Failed to load thread storage",
            lifecycleOperation: "load_thread_storage",
          })
        }
        messageClassName="text-destructive"
      />
    );
  } else if (isFilesLoading && loadedFiles.length === 0) {
    body = loadingState;
  } else if (loadedFiles.length === 0) {
    body = <EmptyState message="No files yet." />;
  } else if (filteredFiles.length === 0) {
    body = <EmptyState message="No files match search." />;
  } else if (model === null) {
    body = loadingState;
  } else {
    body = <LazyThreadStorageFileTree fallback={loadingState} model={model} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {isSearchOpen ? (
        <div className="flex h-7 shrink-0 items-center gap-2 max-md:pointer-coarse:h-10">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="Search"
              className={cn(
                "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
            <Input
              ref={searchInputRef}
              aria-label="Search files"
              className={cn(
                "h-7 pl-7 pr-2 focus-visible:ring-0 max-md:pointer-coarse:h-10",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
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
            className={cn(
              COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
              "shrink-0 text-muted-foreground",
            )}
            aria-label="Close search"
            onClick={closeSearch}
          >
            <Icon name="X" />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
