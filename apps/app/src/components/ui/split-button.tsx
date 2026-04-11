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
}

interface SplitButtonProps {
  primaryAction: SplitButtonAction;
  secondaryActions: SplitButtonAction[];
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
  /** Applied to both the primary and trigger buttons (on top of variant/size). */
  className?: string;
}

function SplitButton({
  primaryAction,
  secondaryActions,
  variant = "outline",
  size = "sm",
  disabled = false,
  className,
}: SplitButtonProps) {
  const base = cn(buttonVariants({ variant, size }), className);

  return (
    <div className="inline-flex items-center">
      <button
        type="button"
        disabled={disabled}
        className={cn(base, "rounded-r-none border-r-0 focus-visible:z-10")}
        onClick={primaryAction.onSelect}
      >
        {primaryAction.label}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(base, "rounded-l-none px-1 focus-visible:z-10")}
            aria-label="More actions"
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={2}>
          {secondaryActions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              onSelect={action.onSelect}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export { SplitButton };
export type { SplitButtonAction, SplitButtonProps };
