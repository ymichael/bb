import { formatDiffCount } from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";

interface DiffStatsTallyProps {
  insertions: number;
  deletions: number;
  hideZero?: boolean;
  className?: string;
}

export function DiffStatsTally({
  insertions,
  deletions,
  hideZero = false,
  className,
}: DiffStatsTallyProps) {
  const showInsertions = !hideZero || insertions > 0;
  const showDeletions = !hideZero || deletions > 0;
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {showInsertions ? (
        <span className="text-diff-added">+{formatDiffCount(insertions)}</span>
      ) : null}
      {showInsertions && showDeletions ? " " : null}
      {showDeletions ? (
        <span className="text-diff-removed">-{formatDiffCount(deletions)}</span>
      ) : null}
    </span>
  );
}
