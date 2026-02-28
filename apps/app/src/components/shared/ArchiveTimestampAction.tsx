import { ArchiveRestore, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ArchiveTimestampAction({
  isPending,
  onUnarchive,
  buttonLabel = "Unarchive thread",
}: {
  isPending?: boolean;
  onUnarchive: () => void;
  buttonLabel?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={buttonLabel}
      title={buttonLabel}
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
