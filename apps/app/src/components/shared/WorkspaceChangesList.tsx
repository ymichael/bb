import type { WorkspaceStatus } from "@bb/domain";
import { TruncateStart } from "@bb/ui-core";
import { EmptyState } from "@bb/ui-core";
import { cn } from "@/lib/utils";
import { formatWorkspaceFileStatus } from "@/lib/workspace-change-summary";

export function WorkspaceChangesList({
  files,
  maxHeightClassName = "max-h-32",
  emptyMessage = "No changed files detected.",
  onFileClick,
  onOpenFile,
}: {
  files: WorkspaceStatus["workingTree"]["files"];
  maxHeightClassName?: string;
  emptyMessage?: string;
  onFileClick?: (file: WorkspaceStatus["workingTree"]["files"][number]) => void;
  onOpenFile?: (relativePath: string) => void;
}) {
  if (!files || files.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  const canClick = onFileClick || onOpenFile;

  return (
    <ul className={cn("space-y-1 overflow-auto", maxHeightClassName)}>
      {files.map((file) => (
        <li
          key={`${file.status}:${file.path}`}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-3"
        >
          <span className="text-xs leading-5 text-muted-foreground/80">
            {formatWorkspaceFileStatus(file.status)}
          </span>
          {canClick ? (
            <button
              type="button"
              className="block min-w-0 text-left text-xs leading-5 underline-offset-2 hover:underline"
              title={file.path}
              onClick={() => {
                if (onFileClick) {
                  onFileClick(file);
                  return;
                }
                onOpenFile?.(file.path);
              }}
            >
              <TruncateStart>{file.path}</TruncateStart>
            </button>
          ) : (
            <TruncateStart className="text-xs leading-5">
              {file.path}
            </TruncateStart>
          )}
        </li>
      ))}
    </ul>
  );
}
