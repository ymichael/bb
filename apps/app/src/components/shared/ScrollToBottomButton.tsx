import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function ScrollToBottomButton({
  visible,
  onClick,
  className,
  ariaLabel = "Scroll to latest event",
}: {
  visible: boolean;
  onClick: () => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("flex h-0 items-center justify-center", className)}>
      <button
        onClick={onClick}
        className={cn(
          "z-20 -mt-20 flex size-8 items-center justify-center rounded-full border border-foreground/20 bg-background/80 shadow-md backdrop-blur-md transition-all duration-200 hover:border-foreground/30 hover:bg-background/90",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-2 opacity-0",
        )}
        aria-label={ariaLabel}
        type="button"
      >
        <ArrowDown className="size-4" />
      </button>
    </div>
  );
}
