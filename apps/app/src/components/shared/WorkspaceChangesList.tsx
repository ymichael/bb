import type { ThreadWorkStatus } from "@bb/core";
import { openThreadPathInEditor } from "@/lib/api";
import { getPathCommandForTarget } from "@/lib/open-path-preferences";
import { cn } from "@/lib/utils";
import { formatWorkspaceFileStatus } from "@/lib/workspace-change-summary";

export function WorkspaceChangesList({
  files,
  threadId,
  maxHeightClassName = "max-h-32",
  emptyMessage = "No changed files detected.",
  onFileClick,
}: {
  files: ThreadWorkStatus["files"];
  threadId?: string;
  maxHeightClassName?: string;
  emptyMessage?: string;
  onFileClick?: (file: NonNullable<ThreadWorkStatus["files"]>[number]) => void;
}) {
  if (!files || files.length === 0) {
    return (
      <p className="ui-text-sm leading-5 text-muted-foreground">{emptyMessage}</p>
    );
  }

  return (
    <ul className={cn("space-y-1 overflow-auto", maxHeightClassName)}>
      {files.map((file) => (
        <li
          key={`${file.status}:${file.path}`}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-3"
        >
          <span className="ui-text-sm leading-5 text-muted-foreground/80">
            {formatWorkspaceFileStatus(file.status)}
          </span>
          {threadId || onFileClick ? (
            <button
              type="button"
              className="min-w-0 truncate text-left ui-text-sm leading-5 underline-offset-2 hover:underline"
              title={file.path}
              onClick={() => {
                if (onFileClick) {
                  onFileClick(file);
                  return;
                }
                if (!threadId) return;
                void openThreadPathInEditor(threadId, {
                  relativePath: file.path,
                  target: "file",
                  command: getPathCommandForTarget("file"),
                });
              }}
            >
              {file.path}
            </button>
          ) : (
            <span className="min-w-0 truncate ui-text-sm leading-5">{file.path}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
