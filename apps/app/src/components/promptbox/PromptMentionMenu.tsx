import type { MutableRefObject } from "react";
import { Loader2 } from "lucide-react";
import type { ProjectFileSuggestion } from "@beanbag/agent-core";
import { cn } from "@/lib/utils";

interface PromptMentionMenuProps {
  showQueryHint: boolean;
  mentionLoading: boolean;
  mentionError: boolean;
  mentionSuggestions: ProjectFileSuggestion[];
  selectedMentionIndex: number;
  mentionItemRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onApplyMention: (item: ProjectFileSuggestion) => void;
}

export function PromptMentionMenu({
  showQueryHint,
  mentionLoading,
  mentionError,
  mentionSuggestions,
  selectedMentionIndex,
  mentionItemRefs,
  onApplyMention,
}: PromptMentionMenuProps) {
  return (
    <div className="mx-3 mb-1 mt-1 overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-sm">
      <div className="max-h-48 overflow-y-auto p-1">
        {showQueryHint ? (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            Type to search project files
          </div>
        ) : mentionLoading ? (
          <div className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Searching files...</span>
          </div>
        ) : mentionError ? (
          <div className="rounded px-2 py-1.5 text-xs text-destructive">
            Couldn&apos;t load files for this project
          </div>
        ) : mentionSuggestions.length > 0 ? (
          mentionSuggestions.map((item, index) => {
            const isSelected = index === selectedMentionIndex;
            return (
              <button
                key={`${item.path}-${index}`}
                ref={(element) => {
                  mentionItemRefs.current[index] = element;
                }}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onApplyMention(item);
                }}
                className={cn(
                  "w-full truncate rounded px-2 py-1.5 text-left text-xs",
                  isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                )}
                title={item.path}
              >
                {item.path}
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
