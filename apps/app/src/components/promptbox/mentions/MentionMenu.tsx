import { useEffect, useMemo, useRef } from "react";
import { Icon, type IconName } from "@/components/ui/icon.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { cn } from "@/lib/utils";
import type {
  MentionMenuState,
  PromptMentionSuggestion,
  ThreadMentionSectionMode,
} from "@/components/promptbox/mentions/types";

interface MentionMenuProps {
  state: MentionMenuState;
  /** Currently-highlighted index in the results list (for keyboard nav). */
  selectedIndex: number;
  onApply: (item: PromptMentionSuggestion) => void;
}

interface MentionSectionItem {
  item: PromptMentionSuggestion;
  index: number;
}

type PathMentionSectionKind = "workspace" | "manager-storage";
type MentionSectionKind = "threads" | PathMentionSectionKind;
type PathMentionSuggestion = Extract<PromptMentionSuggestion, { kind: "path" }>;

const MENTION_SECTION_ORDER: readonly MentionSectionKind[] = [
  "threads",
  "workspace",
  "manager-storage",
];

interface MentionSection {
  kind: MentionSectionKind;
  label: string;
  items: MentionSectionItem[];
}

interface SplitPathResult {
  name: string;
  directory: string;
}

function splitPath(path: string): SplitPathResult {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return { name: path, directory: "" };
  }
  return {
    name: path.slice(lastSlash + 1),
    directory: path.slice(0, lastSlash),
  };
}

function groupSections(
  suggestions: readonly PromptMentionSuggestion[],
  threadSectionMode: ThreadMentionSectionMode,
): MentionSection[] {
  const sectionsByKind = new Map<MentionSectionKind, MentionSection>();
  for (const [index, item] of suggestions.entries()) {
    const kind = getSectionKind(item);
    const existing = sectionsByKind.get(kind);
    if (existing) {
      existing.items.push({ item, index });
      continue;
    }

    sectionsByKind.set(kind, {
      kind,
      label: getSectionLabel(kind, threadSectionMode),
      items: [{ item, index }],
    });
  }

  return MENTION_SECTION_ORDER.flatMap((kind) => {
    const section = sectionsByKind.get(kind);
    return section ? [section] : [];
  });
}

function getSectionKind(item: PromptMentionSuggestion): MentionSectionKind {
  if (item.kind === "thread") {
    return "threads";
  }
  return getPathSectionKind(item);
}

function getPathSectionKind(
  item: PathMentionSuggestion,
): PathMentionSectionKind {
  return item.source === "thread-storage" ? "manager-storage" : "workspace";
}

function getSectionLabel(
  kind: MentionSectionKind,
  threadSectionMode: ThreadMentionSectionMode,
): string {
  if (kind === "threads") {
    return getThreadSectionLabel(threadSectionMode);
  }
  return getPathSectionLabel(kind);
}

function getThreadSectionLabel(mode: ThreadMentionSectionMode): string {
  if (mode === "all") {
    return "Managers & threads";
  }
  if (mode === "managers") {
    return "Managers";
  }
  return "Threads";
}

function getPathSectionLabel(kind: PathMentionSectionKind): string {
  if (kind === "manager-storage") {
    return "Manager Storage";
  }
  return "Workspace";
}

function getMentionIconName(item: PromptMentionSuggestion): IconName {
  if (item.kind === "thread") {
    return item.threadType === "manager" ? "UserRound" : "MessageSquare";
  }
  return item.entryKind === "directory" ? "Folder" : "File";
}

function getMentionTitle(item: PromptMentionSuggestion): string {
  if (item.kind === "thread") {
    return item.title || item.path;
  }

  return `${getPathSectionLabel(getPathSectionKind(item))}: ${item.path}`;
}

function getMentionKey(item: PromptMentionSuggestion, index: number): string {
  if (item.kind === "path") {
    return `${item.kind}-${item.source}-${item.entryKind}-${item.path}-${index}`;
  }
  return `${item.kind}-${item.path}-${index}`;
}

export function MentionMenu({
  state,
  selectedIndex,
  onApply,
}: MentionMenuProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Trim refs when the result list shortens so stale entries don't survive.
  const resultsLength = state.kind === "results" ? state.suggestions.length : 0;
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
    () =>
      state.kind === "results"
        ? groupSections(state.suggestions, state.threadSectionMode)
        : [],
    [state],
  );

  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover text-popover-foreground">
      <div className="max-h-48 overflow-y-auto">
        {state.kind === "hint" ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Type to search mentions
          </div>
        ) : state.kind === "loading" ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Icon name="Spinner" className="size-3.5 animate-spin" />
            <span>Searching mentions&hellip;</span>
          </div>
        ) : state.kind === "error" ? (
          <div className="px-3 py-2 text-xs text-destructive">
            Failed to load suggestions
          </div>
        ) : sections.length > 0 ? (
          <div className="pb-1">
            {sections.map((section) => (
              <div key={section.kind}>
                <div className="sticky top-0 z-10 bg-popover px-3 pb-1 pt-1.5 text-xs text-muted-foreground">
                  {section.label}
                </div>
                <div className="flex flex-col gap-px px-1">
                  {section.items.map(({ item, index }) => {
                    const isSelected = index === selectedIndex;

                    let primary: string;
                    let secondaryDirectory: string | null = null;
                    const iconName = getMentionIconName(item);

                    if (item.kind === "thread") {
                      primary = item.title || "Untitled thread";
                    } else {
                      const { directory } = splitPath(item.path);
                      primary = item.name;
                      secondaryDirectory = directory || null;
                    }

                    return (
                      <button
                        key={getMentionKey(item, index)}
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
                        title={getMentionTitle(item)}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Icon
                            name={iconName}
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate">{primary}</span>
                          {secondaryDirectory !== null ? (
                            // Path directory: shrink it before the basename
                            // so long paths never crowd out the filename in the
                            // row.
                            <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
                              {secondaryDirectory}
                            </TruncateStart>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No matching mentions
          </div>
        )}
      </div>
    </div>
  );
}
