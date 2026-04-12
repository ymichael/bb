import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SplitButtonAction {
  label: string;
  onSelect: () => void;
  content?: ReactNode;
}

interface SplitButtonProps {
  primaryAction: SplitButtonAction;
  secondaryActions: SplitButtonAction[];
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
  /** Applied to both the primary and trigger buttons (on top of variant/size). */
  className?: string;
  triggerLabel?: string;
  mobileTitle?: string;
}

function SplitButton({
  primaryAction,
  secondaryActions,
  variant = "outline",
  size = "sm",
  disabled = false,
  className,
  triggerLabel = "More actions",
  mobileTitle,
}: SplitButtonProps) {
  const base = cn(buttonVariants({ variant, size }), className);

  return (
    <div className="inline-flex items-center">
      <button
        type="button"
        disabled={disabled}
        className={cn(base, "rounded-r-none border-r-0 focus-visible:z-10")}
        aria-label={primaryAction.label}
        title={primaryAction.label}
        onClick={primaryAction.onSelect}
      >
        {primaryAction.content ?? primaryAction.label}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(base, "rounded-l-none px-1 focus-visible:z-10")}
            aria-label={triggerLabel}
            title={triggerLabel}
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={2} mobileTitle={mobileTitle}>
          {secondaryActions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              onSelect={action.onSelect}
              textValue={action.label}
            >
              {action.content ?? action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export { SplitButton };
export type { SplitButtonAction, SplitButtonProps };
