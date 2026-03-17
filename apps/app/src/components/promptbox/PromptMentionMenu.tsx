import type { MutableRefObject } from "react";
import { FileText, FolderGit2, Loader2, UserRound } from "lucide-react";
import type { PromptMentionSuggestion } from "@bb/core";
import { cn } from "@/lib/utils";

interface PromptMentionMenuProps {
  showQueryHint: boolean;
  mentionSearchScope: "files" | "files-and-managers" | "files-and-threads";
  mentionLoading: boolean;
  mentionError: boolean;
  mentionSuggestions: PromptMentionSuggestion[];
  selectedMentionIndex: number;
  mentionItemRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onApplyMention: (item: PromptMentionSuggestion) => void;
}

export function PromptMentionMenu({
  showQueryHint,
  mentionSearchScope,
  mentionLoading,
  mentionError,
  mentionSuggestions,
  selectedMentionIndex,
  mentionItemRefs,
  onApplyMention,
}: PromptMentionMenuProps) {
  const searchLabel =
    mentionSearchScope === "files-and-threads"
      ? "files, managers, and threads"
      : mentionSearchScope === "files-and-managers"
        ? "files and managers"
        : "files";

  return (
    <div className="mx-3 mb-1 mt-1 overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-sm">
      <div className="max-h-48 overflow-y-auto p-1">
        {showQueryHint ? (
          <div className="rounded px-2 py-1.5 text-xs text-muted-foreground">
            {mentionSearchScope === "files"
              ? "Type to search project files"
              : `Type to search ${searchLabel}`}
          </div>
        ) : mentionLoading ? (
          <div className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>{`Searching ${searchLabel}...`}</span>
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
                ? item.threadType === "manager"
                  ? `Manager · ${item.threadId}`
                  : "Thread"
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
                      <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
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
            {mentionSearchScope === "files"
              ? "No matching files"
              : `No matching ${searchLabel}`}
          </div>
        )}
      </div>
    </div>
  );
}
