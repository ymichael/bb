import { ArrowDown } from "lucide-react";
import { cn } from "./cn.js";

export interface ScrollToBottomButtonProps {
  visible: boolean;
  active?: boolean;
  onClick: () => void;
  className?: string;
  ariaLabel?: string;
}

export function ScrollToBottomButton({
  visible,
  active = false,
  onClick,
  className,
  ariaLabel = "Scroll to latest event",
}: ScrollToBottomButtonProps) {
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
        {active ? <TypingDots /> : <ArrowDown className="size-4" />}
      </button>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      <span className="size-1 animate-typing-dot rounded-full bg-current [animation-delay:-240ms]" />
      <span className="size-1 animate-typing-dot rounded-full bg-current [animation-delay:-120ms]" />
      <span className="size-1 animate-typing-dot rounded-full bg-current" />
    </span>
  );
}
