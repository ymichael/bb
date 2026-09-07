import { Fragment, type ReactElement, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { buttonVariants } from "@bb/shared-ui/button";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";

const SPLIT_BUTTON_TOOLBAR_CLASS = COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS;

function OptionalTooltip({
  children,
  content,
  wrapTrigger = false,
}: {
  children: ReactElement;
  content?: string;
  wrapTrigger?: boolean;
}) {
  if (!content) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {wrapTrigger ? (
          <span className="inline-flex">{children}</span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}

interface SplitButtonAction {
  ariaKeyshortcuts?: string;
  groupLabel?: string;
  label: string;
  onSelect: () => void;
  content?: ReactNode;
}

interface SplitButtonProps {
  primaryAction: SplitButtonAction;
  secondaryActions: SplitButtonAction[];
  disabled?: boolean;
  className?: string;
  triggerLabel?: string;
  primaryTooltip?: string;
  triggerTooltip?: string;
  mobileTitle?: string;
  defaultOpen?: boolean;
  modal?: boolean;
}

function SplitButton({
  primaryAction,
  secondaryActions,
  disabled = false,
  className,
  triggerLabel = "More actions",
  primaryTooltip,
  triggerTooltip,
  mobileTitle,
  defaultOpen,
  modal,
}: SplitButtonProps) {
  const base = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    SPLIT_BUTTON_TOOLBAR_CLASS,
    className,
  );
  const primaryButton = (
    <button
      type="button"
      disabled={disabled}
      className={cn(base, "rounded-r-none border-r-0 pr-1 focus-visible:z-10")}
      aria-label={primaryAction.label}
      aria-keyshortcuts={primaryAction.ariaKeyshortcuts}
      onClick={primaryAction.onSelect}
    >
      {primaryAction.content ?? primaryAction.label}
    </button>
  );
  const menuTrigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        disabled={disabled}
        className={cn(
          base,
          "rounded-l-none border-l-0 px-1 focus-visible:z-10",
          "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
        )}
        aria-label={triggerLabel}
      >
        <Icon name="ChevronDown" className="size-3" />
      </button>
    </DropdownMenuTrigger>
  );

  return (
    <div className="inline-flex items-center">
      <OptionalTooltip content={primaryTooltip}>
        {primaryButton}
      </OptionalTooltip>
      <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
        <OptionalTooltip content={triggerTooltip} wrapTrigger>
          {menuTrigger}
        </OptionalTooltip>
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
export type { SplitButtonAction };
