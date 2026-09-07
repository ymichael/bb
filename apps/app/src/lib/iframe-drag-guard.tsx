import { cn } from "@bb/shared-ui/lib/utils";

interface IframeDragGuardOverlayProps {
  active: boolean;
  cursor: "col-resize" | "row-resize";
}

export function IframeDragGuardOverlay({
  active,
  cursor,
}: IframeDragGuardOverlayProps) {
  if (!active) {
    return null;
  }
  return (
    <div
      aria-hidden
      data-testid="iframe-drag-guard-overlay"
      className={cn(
        "fixed inset-0 z-50",
        cursor === "col-resize" ? "cursor-col-resize" : "cursor-row-resize",
      )}
    />
  );
}
