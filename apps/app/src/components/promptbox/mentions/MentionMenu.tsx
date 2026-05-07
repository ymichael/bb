import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Pill, TruncateStart } from "@/components/ui";
import { cn } from "@/lib/utils";
import type {
  MentionMenuState,
  PromptMentionSuggestion,
} from "@/components/promptbox/mentions/types";

interface MentionMenuProps {
  state: MentionMenuState;
  /** Currently-highlighted index in the results list (for keyboard nav). */
  selectedIndex: number;
  onApply: (item: PromptMentionSuggestion) => void;
}

/** Extract the basename and parent directory from a file path. */
function splitFilePath(filePath: string): { name: string; directory: string } {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) {
    return { name: filePath, directory: "" };
  }
  return {
    name: filePath.slice(lastSlash + 1),
    directory: filePath.slice(0, lastSlash),
  };
}

export function MentionMenu({
  state,
  selectedIndex,
  onApply,
}: MentionMenuProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Trim refs when the result list shortens so stale entries don't survive.
  const resultsLength =
    state.kind === "results" ? state.suggestions.length : 0;
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, resultsLength);
  }, [resultsLength]);

  // Keep the highlighted row visible as the user arrows through the list.
  useEffect(() => {
    if (state.kind !== "results" || state.suggestions.length === 0) return;
    const selectedItem = itemRefs.current[selectedIndex];
    if (!selectedItem) return;
    selectedItem.scrollIntoView({ block: "nearest" });
  }, [resultsLength, selectedIndex, state.kind, state]);

  return (
    <div className="mx-3 mb-1 mt-1 overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-sm">
      <div className="max-h-48 overflow-y-auto p-1">
        {state.kind === "hint" ? (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            Type to search files
          </div>
        ) : state.kind === "loading" ? (
          <div className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Searching files&hellip;</span>
          </div>
        ) : state.kind === "error" ? (
          <div className="rounded px-2 py-1.5 text-xs text-destructive">
            Failed to load suggestions
          </div>
        ) : state.suggestions.length > 0 ? (
          state.suggestions.map((item, index) => {
            const isSelected = index === selectedIndex;
            const previousKind =
              index === 0 ? null : state.suggestions[index - 1]!.kind;
            const showSectionHeader = item.kind !== previousKind;

            let primary: string;
            let secondaryDirectory: string | null = null;
            let threadTypeLabel: string | null = null;

            if (item.kind === "thread") {
              primary = item.title || "Untitled thread";
              threadTypeLabel =
                item.threadType === "manager" ? "Manager" : "Thread";
            } else {
              const { name, directory } = splitFilePath(item.path);
              primary = name;
              secondaryDirectory = directory || null;
            }

            return (
              <div key={`${item.kind}-${item.path}-${index}`}>
                {showSectionHeader ? (
                  <div
                    className={cn(
                      "px-2 pb-0.5 text-xs text-muted-foreground/60",
                      index === 0 ? "pt-1" : "pt-2",
                    )}
                  >
                    {item.kind === "thread" ? "Threads" : "Files"}
                  </div>
                ) : null}
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onApply(item);
                  }}
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left text-xs",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/70",
                  )}
                  title={item.path}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{primary}</span>
                    {secondaryDirectory !== null ? (
                      // File dirpath: shrink directory before the basename so
                      // long paths never crowd out the filename in the row.
                      <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
                        {secondaryDirectory}
                      </TruncateStart>
                    ) : null}
                    {threadTypeLabel !== null ? (
                      <Pill variant="outline" className="shrink-0">
                        {threadTypeLabel}
                      </Pill>
                    ) : null}
                  </div>
                </button>
              </div>
            );
          })
        ) : (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            No matching files
          </div>
        )}
      </div>
    </div>
  );
}
