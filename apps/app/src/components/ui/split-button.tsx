import { Fragment, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SplitButtonAction {
  groupLabel?: string;
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
        className={cn(
          base,
          "rounded-r-none border-r-0 pr-1 focus-visible:z-10",
        )}
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
            className={cn(
              base,
              "rounded-l-none border-l-0 px-1 pl-0 focus-visible:z-10",
              "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
            )}
            aria-label={triggerLabel}
            title={triggerLabel}
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={2}
          mobileTitle={mobileTitle}
        >
          {secondaryActions.map((action, index) => {
            const previousAction = secondaryActions[index - 1];
            const showGroupLabel =
              action.groupLabel !== undefined &&
              action.groupLabel !== previousAction?.groupLabel;

            return (
              <Fragment key={action.label}>
                {showGroupLabel ? (
                  <>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuLabel>{action.groupLabel}</DropdownMenuLabel>
                  </>
                ) : null}
                <DropdownMenuItem
                  onSelect={action.onSelect}
                  textValue={action.label}
                >
                  {action.content ?? action.label}
                </DropdownMenuItem>
              </Fragment>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export { SplitButton };
export type { SplitButtonAction, SplitButtonProps };
