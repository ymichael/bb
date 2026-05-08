import { type ComponentType } from "react";
import { GitMerge } from "lucide-react";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { OptionDisplay } from "@/components/pickers/OptionPicker";
import { copyToClipboardWithToast } from "@/lib/clipboard";

export interface ThreadEnvironmentSummaryProps {
  /** Mode label (e.g. "Working locally" / "Worktree" / "E2B Sandbox"). Never truncates. */
  environmentLabel?: string;
  /** Remote host name shown after the mode label as a muted suffix. Hidden below `lg`. */
  environmentHostLabel?: string;
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
 *
 * Responsive behavior:
 * - Mode label always visible, never truncates.
 * - Remote host suffix hidden below `lg` (1024px).
 * - Branch chip hidden below `md` (768px), truncates within its space above.
 */
export function ThreadEnvironmentSummary({
  environmentLabel,
  environmentHostLabel,
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
            <span className="flex items-center gap-1.5">
              <span>{environmentLabel}</span>
              {environmentHostLabel ? (
                <span className="hidden text-muted-foreground/60 lg:inline">
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
          icon={environmentIcon}
          className="h-6 shrink-0"
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
