import type { ThreadType } from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import { threadTypeLabel } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

export function ThreadUnarchiveButton({
  isPending,
  onUnarchive,
  buttonLabel,
  threadType,
  className,
}: {
  isPending?: boolean;
  onUnarchive: () => void;
  buttonLabel?: string;
  threadType?: ThreadType;
  className?: string;
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
      className={cn("size-6", className)}
    >
      {isPending ? (
        <Icon name="Spinner" className="size-3 animate-spin" />
      ) : (
        <Icon name="ArchiveRestore" className="size-3" />
      )}
    </Button>
  );
}
