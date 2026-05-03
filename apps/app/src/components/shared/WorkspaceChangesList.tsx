import type { WorkspaceStatus } from "@bb/domain";
import { EmptyState, FilePathLink } from "@bb/ui-core";
import { cn } from "@/lib/utils";
import { formatWorkspaceFileStatus } from "@/lib/workspace-change-summary";

export type WorkspaceChangedFile =
  WorkspaceStatus["workingTree"]["files"][number];

export function WorkspaceChangesList({
  files,
  maxHeightClassName = "max-h-32",
  emptyMessage = "No changed files detected.",
  onFileClick,
}: {
  files: readonly WorkspaceChangedFile[];
  maxHeightClassName?: string;
  emptyMessage?: string;
  onFileClick?: (file: WorkspaceChangedFile) => void;
}) {
  if (!files || files.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

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
          <FilePathLink
            path={file.path}
            onClick={onFileClick ? () => onFileClick(file) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}
