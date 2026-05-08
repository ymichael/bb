import type { ThreadType } from "@bb/domain";
import { ArchiveRestore, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { threadTypeLabel } from "@/lib/thread-title";

export function ThreadUnarchiveButton({
  isPending,
  onUnarchive,
  buttonLabel,
  threadType,
}: {
  isPending?: boolean;
  onUnarchive: () => void;
  buttonLabel?: string;
  threadType?: ThreadType;
}) {
  const resolvedLabel =
    buttonLabel ?? `Unarchive ${threadTypeLabel(threadType ?? "standard")}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={resolvedLabel}
      title={resolvedLabel}
      onClick={onUnarchive}
      disabled={Boolean(isPending)}
      className="size-6"
    >
      {isPending ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : (
        <ArchiveRestore className="size-3" />
      )}
    </Button>
  );
}
