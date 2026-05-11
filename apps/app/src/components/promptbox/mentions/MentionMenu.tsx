import { useEffect, useMemo, useRef } from "react";
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

interface MentionSection {
  kind: PromptMentionSuggestion["kind"];
  label: string;
  items: Array<{ item: PromptMentionSuggestion; index: number }>;
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

function groupSections(
  suggestions: readonly PromptMentionSuggestion[],
): MentionSection[] {
  const sections: MentionSection[] = [];
  suggestions.forEach((item, index) => {
    const last = sections[sections.length - 1];
    if (!last || last.kind !== item.kind) {
      sections.push({
        kind: item.kind,
        label: item.kind === "thread" ? "Threads" : "Files",
        items: [],
      });
    }
    sections[sections.length - 1]!.items.push({ item, index });
  });
  return sections;
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

  const sections = useMemo(
    () => (state.kind === "results" ? groupSections(state.suggestions) : []),
    [state],
  );

  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground">
      <div className="max-h-48 overflow-y-auto pb-1">
        {state.kind === "hint" ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Type to search files
          </div>
        ) : state.kind === "loading" ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Searching files&hellip;</span>
          </div>
        ) : state.kind === "error" ? (
          <div className="px-3 py-2 text-xs text-destructive">
            Failed to load suggestions
          </div>
        ) : sections.length > 0 ? (
          sections.map((section) => (
            <div key={section.kind}>
              <div className="sticky top-0 z-10 bg-popover px-3 pb-1 pt-1.5 text-xs text-muted-foreground/60">
                {section.label}
              </div>
              <div className="flex flex-col gap-px px-1">
                {section.items.map(({ item, index }) => {
                  const isSelected = index === selectedIndex;

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
                    <button
                      key={`${item.kind}-${item.path}-${index}`}
                      ref={(element) => {
                        itemRefs.current[index] = element;
                      }}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onApply(item);
                      }}
                      // scroll-mt-7 keeps the row from being scrolled
                      // underneath the sticky section header.
                      className={cn(
                        "w-full scroll-mt-7 rounded px-2 py-1.5 text-left text-xs",
                        isSelected
                          ? "bg-state-active text-foreground"
                          : "hover:bg-state-hover",
                      )}
                      title={item.path}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{primary}</span>
                        {secondaryDirectory !== null ? (
                          // File dirpath: shrink directory before the basename
                          // so long paths never crowd out the filename in the
                          // row.
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
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No matching files
          </div>
        )}
      </div>
    </div>
  );
}
