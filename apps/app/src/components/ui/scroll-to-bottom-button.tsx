import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";

interface ScrollToBottomButtonProps {
  visible: boolean;
  active?: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({
  visible,
  active = false,
  onClick,
}: ScrollToBottomButtonProps) {
  return (
    <div className="flex h-0 items-center justify-center">
      <button
        onClick={onClick}
        className={cn(
          "z-20 -mt-20 flex size-8 cursor-pointer items-center justify-center rounded-full border border-border bg-background transition-all duration-200 hover:bg-accent",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-2 opacity-0",
        )}
        aria-label="Scroll to latest event"
        type="button"
      >
        {}
        <Icon
          name="ArrowDown"
          className={cn("size-4", active && visible && "animate-shine-icon")}
        />
      </button>
    </div>
  );
}
