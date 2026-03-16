import type { MutableRefObject } from "react";
import { FileText, FolderGit2, Loader2, UserRound } from "lucide-react";
import type { PromptMentionSuggestion } from "@bb/core";
import { cn } from "@/lib/utils";

interface PromptMentionMenuProps {
  showQueryHint: boolean;
  mentionLoading: boolean;
  mentionError: boolean;
  mentionSuggestions: PromptMentionSuggestion[];
  selectedMentionIndex: number;
  mentionItemRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onApplyMention: (item: PromptMentionSuggestion) => void;
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
  const containsThreadSuggestions = mentionSuggestions.some(
    (item) => item.kind === "thread",
  );

  return (
    <div className="mx-3 mb-1 mt-1 overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-sm">
      <div className="max-h-48 overflow-y-auto p-1">
        {showQueryHint ? (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            {containsThreadSuggestions
              ? "Type to search files and threads"
              : "Type to search project files"}
          </div>
        ) : mentionLoading ? (
          <div className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>
              {containsThreadSuggestions ? "Searching files and threads..." : "Searching files..."}
            </span>
          </div>
        ) : mentionError ? (
          <div className="rounded px-2 py-1.5 text-xs text-destructive">
            Couldn&apos;t load mentions for this project
          </div>
        ) : mentionSuggestions.length > 0 ? (
          mentionSuggestions.map((item, index) => {
            const isSelected = index === selectedMentionIndex;
            const title =
              item.kind === "thread"
                ? item.title || item.path
                : item.path;
            const subtitle =
              item.kind === "thread"
                ? `${item.threadType === "manager" ? "Manager" : "Thread"} · ${item.threadId}`
                : item.path;
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
                  isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                )}
                title={item.path}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {item.kind === "thread" ? (
                    item.threadType === "manager" ? (
                      <UserRound className="size-3.5 shrink-0" />
                    ) : (
                      <FolderGit2 className="size-3.5 shrink-0" />
                    )
                  ) : (
                    <FileText className="size-3.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate">{title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {subtitle}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        ) : (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            {containsThreadSuggestions ? "No matching files or threads" : "No matching files"}
          </div>
        )}
      </div>
    </div>
  );
}
