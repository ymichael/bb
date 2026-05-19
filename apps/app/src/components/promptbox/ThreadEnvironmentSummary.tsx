import { memo } from "react";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { OptionDisplay } from "@/components/pickers/OptionPicker";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { Icon, type IconName } from "@/components/ui/icon.js";

export interface ThreadEnvironmentSummaryProps {
  /** Mode label (e.g. "Working locally" / "Worktree"). Never truncates. */
  environmentLabel?: string;
  /** Remote host name shown after the mode label as a muted suffix. Hidden below `lg`. */
  environmentHostLabel?: string;
  /** Whether the host backing the environment is connected. */
  environmentHostConnected?: boolean;
  /** Icon for the environment (e.g. monitor / git branch). */
  environmentIcon?: IconName;
  /** Branch name if the environment runs on a worktree. Renders a copy-to-clipboard button. */
  environmentBranchName?: string;
  /** When set, render a "new thread in this worktree" affordance beside the
   * environment label. Caller is responsible for only providing this when the
   * environment is a worktree. */
  onCreateNewThreadInWorktree?: () => void;
}

/**
 * Inline strip shown in the follow-up composer that describes the thread's
 * current environment: label, host connection status, and (when on a
 * worktree) a copy-branch button. Read-only — environment editing happens
 * elsewhere.
 *
 * Responsive behavior:
 * - Mode label always visible, never truncates.
 * - Remote host suffix hidden below `lg` (1024px).
 * - Branch chip hidden below `md` (768px), truncates within its space above.
 */
export const ThreadEnvironmentSummary = memo(function ThreadEnvironmentSummary({
  environmentLabel,
  environmentHostLabel,
  environmentHostConnected,
  environmentIcon,
  environmentBranchName,
  onCreateNewThreadInWorktree,
}: ThreadEnvironmentSummaryProps) {
  if (!environmentLabel && environmentHostConnected === undefined) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-2 pr-1.5">
      {environmentLabel ? (
        <OptionDisplay
          label="Environment"
          value={
            <span className="flex items-center gap-1.5">
              <span>{environmentLabel}</span>
              {environmentHostLabel ? (
                <span className="hidden text-muted-foreground lg:inline">
                  · {environmentHostLabel}
                </span>
              ) : null}
              {environmentHostConnected !== undefined ? (
                <HostStatusBadge
                  connected={environmentHostConnected}
                  className="translate-y-px"
                />
              ) : null}
            </span>
          }
          leading={
            environmentIcon ? (
              <Icon name={environmentIcon} className="size-4 shrink-0" />
            ) : null
          }
          className="h-6 shrink-0"
          muted
        />
      ) : environmentHostConnected !== undefined ? (
        <HostStatusBadge connected={environmentHostConnected} />
      ) : null}
      {environmentBranchName ? (
        <button
          type="button"
          className="hidden min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground md:flex"
          title={`Copy branch name: ${environmentBranchName}`}
          onClick={() => {
            void copyToClipboardWithToast(environmentBranchName, {
              successMessage: "Branch name copied",
              errorMessage: "Failed to copy branch name",
            });
          }}
        >
          <Icon name="GitMerge" className="size-3.5 shrink-0" />
          <span className="truncate">{environmentBranchName}</span>
        </button>
      ) : null}
      {onCreateNewThreadInWorktree ? (
        <button
          type="button"
          aria-label="Create new thread in this worktree"
          title="New thread in this worktree"
          onClick={onCreateNewThreadInWorktree}
          className="-ml-1 inline-flex shrink-0 items-center justify-center rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="MessageSquarePlus" className="size-4" />
        </button>
      ) : null}
    </div>
  );
});
