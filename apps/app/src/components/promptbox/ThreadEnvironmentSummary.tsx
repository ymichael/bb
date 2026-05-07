import { type ComponentType, type ReactNode } from "react";
import { GitMerge } from "lucide-react";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { OptionDisplay } from "@/components/pickers/OptionPicker";
import { copyToClipboardWithToast } from "@/lib/clipboard";

export interface ThreadEnvironmentSummaryProps {
  /** Display label for the environment (e.g. "Direct" / "Worktree" / sandbox name). */
  environmentLabel?: ReactNode;
  /** Whether the host backing the environment is connected. */
  environmentHostConnected?: boolean;
  /** Icon for the environment (e.g. monitor / container). */
  environmentIcon?: ComponentType<{ className?: string }>;
  /** Branch name if the environment runs on a worktree. Renders a copy-to-clipboard button. */
  environmentBranchName?: string;
}

/**
 * Inline strip shown in the follow-up composer that describes the thread's
 * current environment: label, host connection status, and (when on a
 * worktree) a copy-branch button. Read-only — environment editing happens
 * elsewhere.
 */
export function ThreadEnvironmentSummary({
  environmentLabel,
  environmentHostConnected,
  environmentIcon,
  environmentBranchName,
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
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{environmentLabel}</span>
              {environmentHostConnected !== undefined ? (
                <HostStatusBadge
                  connected={environmentHostConnected}
                  className="translate-y-px"
                />
              ) : null}
            </span>
          }
          icon={environmentIcon}
          className="h-6 min-w-[80px]"
          muted
        />
      ) : environmentHostConnected !== undefined ? (
        <HostStatusBadge connected={environmentHostConnected} />
      ) : null}
      {environmentBranchName ? (
        <button
          type="button"
          className="hidden min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground/75 transition-colors hover:bg-accent hover:text-foreground md:flex"
          title={`Copy branch name: ${environmentBranchName}`}
          onClick={() => {
            void copyToClipboardWithToast(environmentBranchName, {
              successMessage: "Branch name copied",
              errorMessage: "Failed to copy branch name",
            });
          }}
        >
          <GitMerge className="size-3.5 shrink-0" />
          <span className="truncate">{environmentBranchName}</span>
        </button>
      ) : null}
    </div>
  );
}
