import { Fragment, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SPLIT_BUTTON_TOOLBAR_CLASS =
  "h-9 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground md:h-8";

interface SplitButtonAction {
  groupLabel?: string;
  label: string;
  onSelect: () => void;
  content?: ReactNode;
}

interface SplitButtonProps {
  primaryAction: SplitButtonAction;
  secondaryActions: SplitButtonAction[];
  disabled?: boolean;
  /** Escape hatch for targeted overrides (e.g. tighter padding for icon-only primaries). Applied to both buttons. */
  className?: string;
  triggerLabel?: string;
  mobileTitle?: string;
}

function SplitButton({
  primaryAction,
  secondaryActions,
  disabled = false,
  className,
  triggerLabel = "More actions",
  mobileTitle,
}: SplitButtonProps) {
  const base = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    SPLIT_BUTTON_TOOLBAR_CLASS,
    className,
  );

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
