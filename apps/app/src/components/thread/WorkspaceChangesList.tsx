import type { WorkspaceStatus } from "@bb/domain";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { EmptyState } from "@/components/ui/empty-state.js";
import { FilePathLink } from "@/components/ui/file-path-link.js";
import { cn } from "@/lib/utils";
import { formatWorkspaceFileStatus } from "@/components/workspace/workspace-change-summary";

export type WorkspaceChangedFile =
  WorkspaceStatus["workingTree"]["files"][number];

export interface WorkspaceChangesListProps {
  files: readonly WorkspaceChangedFile[];
  className?: string;
  emptyMessage?: string;
  onFileClick?: (file: WorkspaceChangedFile) => void;
}

export function WorkspaceChangesList({
  files,
  className = "max-h-32",
  emptyMessage = "No changed files detected.",
  onFileClick,
}: WorkspaceChangesListProps) {
  if (!files || files.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <ul className={cn("space-y-1 overflow-auto", className)}>
      {files.map((file) => (
        <li
          key={`${file.status}:${file.path}`}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3"
        >
          <span className="text-xs leading-5 text-muted-foreground">
            {formatWorkspaceFileStatus(file.status)}
          </span>
          <FilePathLink
            path={file.path}
            onClick={onFileClick ? () => onFileClick(file) : undefined}
          />
          {file.insertions !== null && file.deletions !== null ? (
            <DiffStatsTally
              insertions={file.insertions}
              deletions={file.deletions}
              hideZero
              className="text-xs leading-5"
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
