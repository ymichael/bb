import { memo } from "react";
import { OptionDisplay } from "@bb/shared-ui/option-display";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import type { EnvironmentWorkspaceTypeLabel } from "@/lib/environment-workspace-display";
import type { WorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";

const CHECKOUT_CHIP_BASE_CLASS_NAME =
  "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground";
const CHECKOUT_CHIP_BUTTON_CLASS_NAME = `${CHECKOUT_CHIP_BASE_CLASS_NAME} cursor-pointer transition-colors hover:bg-state-hover hover:text-foreground`;

interface ThreadEnvironmentSummaryProps {
  projectName?: string;
  environmentLabel?: string;
  environmentCompactLabel?: string;
  environmentIcon?: IconName;
  environmentTypeLabel?: EnvironmentWorkspaceTypeLabel;
  environmentCheckout?: WorkspaceCheckoutDisplay;
  onCreateNewThreadInWorktree?: () => void;
}

export const ThreadEnvironmentSummary = memo(function ThreadEnvironmentSummary({
  projectName,
  environmentLabel,
  environmentCompactLabel,
  environmentIcon,
  environmentTypeLabel,
  environmentCheckout,
  onCreateNewThreadInWorktree,
}: ThreadEnvironmentSummaryProps) {
  if (
    !projectName &&
    !environmentLabel &&
    !environmentCheckout &&
    !onCreateNewThreadInWorktree
  ) {
    return null;
  }

  const checkoutCopyValue = environmentCheckout?.copyValue ?? null;
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 pr-1.5">
      {projectName ? (
        <OptionDisplay
          label="Project"
          value={projectName}
          compactValue={projectName}
          leading={<Icon name="Folder" className="size-4 shrink-0" />}
          className="h-6 min-w-0 max-w-[10rem] shrink"
          tooltip={`Project: ${projectName}`}
          muted
        />
      ) : null}
      {environmentLabel ? (
        <div className="inline-flex h-6 w-fit max-w-full min-w-0 shrink items-center justify-start gap-1.5 px-1 text-xs leading-tight text-muted-foreground">
          {environmentIcon && environmentTypeLabel ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  tabIndex={0}
                  aria-label={`Environment type: ${environmentTypeLabel}`}
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Icon name={environmentIcon} className="size-4" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{environmentTypeLabel}</TooltipContent>
            </Tooltip>
          ) : environmentIcon ? (
            <Icon
              name={environmentIcon}
              className={cn(
                "size-4 shrink-0",
                environmentIcon === "Loading" && "animate-spin",
              )}
            />
          ) : null}
          <OptionDisplay
            label="Environment"
            value={environmentLabel}
            compactValue={environmentCompactLabel}
            className="h-6 min-w-0 shrink px-0"
            tooltip={environmentLabel}
            muted
          />
        </div>
      ) : null}
      {environmentCheckout && checkoutCopyValue !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-promptbox-hide-branch-compact=""
              className={CHECKOUT_CHIP_BUTTON_CLASS_NAME}
              onClick={() => {
                void copyToClipboardWithToast(checkoutCopyValue, {
                  successMessage:
                    environmentCheckout.copySuccessMessage ?? "Value copied",
                  errorMessage:
                    environmentCheckout.copyErrorMessage ??
                    "Failed to copy value",
                });
              }}
            >
              <Icon name="GitBranch" className="size-3.5 shrink-0" />
              <span className="truncate">{environmentCheckout.label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{environmentCheckout.title}</TooltipContent>
        </Tooltip>
      ) : environmentCheckout ? (
        <span
          data-promptbox-hide-branch-compact=""
          className={CHECKOUT_CHIP_BASE_CLASS_NAME}
          title={environmentCheckout.title}
        >
          <Icon name="GitBranch" className="size-3.5 shrink-0" />
          <span className="truncate">{environmentCheckout.label}</span>
        </span>
      ) : null}
      {onCreateNewThreadInWorktree ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Create thread in worktree"
              onClick={onCreateNewThreadInWorktree}
              className={cn(
                "-ml-1 inline-flex cursor-pointer shrink-0 items-center justify-center rounded-md px-1 py-0.5 transition-colors hover:bg-state-hover",
                CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              )}
            >
              <Icon name="MessageSquarePlus" className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Create thread in worktree</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
});
