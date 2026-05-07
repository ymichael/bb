import type { MutableRefObject } from "react";
import { Loader2 } from "lucide-react";
import { TruncateStart } from "@/components/ui";
import type { PromptMentionSuggestion } from "@/hooks/usePromptMentions";
import { cn } from "@/lib/utils";

interface MentionMenuProps {
  showQueryHint: boolean;
  mentionLoading: boolean;
  mentionError: boolean;
  mentionSuggestions: PromptMentionSuggestion[];
  selectedMentionIndex: number;
  mentionItemRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onApplyMention: (item: PromptMentionSuggestion) => void;
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
  showQueryHint,
  mentionLoading,
  mentionError,
  mentionSuggestions,
  selectedMentionIndex,
  mentionItemRefs,
  onApplyMention,
}: MentionMenuProps) {
  return (
    <div className="mx-3 mb-1 mt-1 overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-sm">
      <div className="max-h-48 overflow-y-auto p-1">
        {showQueryHint ? (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            Type to search files
          </div>
        ) : mentionLoading ? (
          <div className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Searching files&hellip;</span>
          </div>
        ) : mentionError ? (
          <div className="rounded px-2 py-1.5 text-xs text-destructive">
            Couldn&apos;t load mentions for this project
          </div>
        ) : mentionSuggestions.length > 0 ? (
          mentionSuggestions.map((item, index) => {
            const isSelected = index === selectedMentionIndex;

            let primary: string;
            let secondary: string | null = null;
            let typeLabel: string | null = null;

            if (item.kind === "thread") {
              primary = item.title || "Untitled thread";
              typeLabel = item.threadType === "manager" ? "Manager" : "Thread";
            } else {
              const { name, directory } = splitFilePath(item.path);
              primary = name;
              secondary = directory || null;
            }

            return (
              <button
                key={`${item.kind}-${item.path}-${index}`}
                ref={(element) => {
                  mentionItemRefs.current[index] = element;
                }}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onApplyMention(item);
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
                  {typeLabel !== null ? (
                    <span className="shrink-0 rounded bg-muted px-1 py-px text-xs text-muted-foreground">
                      {typeLabel}
                    </span>
                  ) : null}
                  <span className="truncate">{primary}</span>
                  {secondary !== null ? (
                    // Directory shrinks before the filename does so a long path
                    // never crowds out the basename in the row.
                    <TruncateStart className="ml-auto pl-2 text-muted-foreground [flex-shrink:9999]">
                      {secondary}
                    </TruncateStart>
                  ) : null}
                </div>
              </button>
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
