import { cn } from "./cn.js";

export interface DiffStatsTallyProps {
  insertions: number;
  deletions: number;
  className?: string;
}

export function DiffStatsTally({
  insertions,
  deletions,
  className,
}: DiffStatsTallyProps) {
  return (
    <span className={cn("whitespace-nowrap", className)}>
      <span className="text-diff-added">+{insertions}</span>{" "}
      <span className="text-diff-removed">-{deletions}</span>
    </span>
  );
}
