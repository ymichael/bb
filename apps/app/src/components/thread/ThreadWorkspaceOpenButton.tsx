import { useCallback, useState } from "react";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import {
  SplitButton,
  type SplitButtonAction,
} from "@/components/ui/split-button.js";
import { WorkspaceOpenTargetIcon } from "@/components/workspace-open-target/WorkspaceOpenTargetIcon";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";

interface ThreadWorkspaceOpenButtonProps {
  onOpenPreferredTarget: () => Promise<void>;
  onOpenTarget: (targetId: WorkspaceOpenTargetId) => Promise<void>;
  preferredTarget: WorkspaceOpenTarget | null;
  targets: WorkspaceOpenTarget[];
}

export function ThreadWorkspaceOpenButton({
  onOpenPreferredTarget,
  onOpenTarget,
  preferredTarget,
  targets,
}: ThreadWorkspaceOpenButtonProps) {
  const [pendingTargetId, setPendingTargetId] =
    useState<WorkspaceOpenTargetId | null>(null);
  const shortcut = useAppCommandShortcut("workspace.openPreferred");
  const isPending = pendingTargetId !== null;

  const openTarget = useCallback(
    async (target: WorkspaceOpenTarget, action: () => Promise<void>) => {
      if (pendingTargetId !== null) {
        return;
      }

      setPendingTargetId(target.id);
      try {
        await action();
      } finally {
        setPendingTargetId(null);
      }
    },
    [pendingTargetId],
  );

  if (!preferredTarget) {
    return null;
  }

  const primaryAction: SplitButtonAction = {
    ariaKeyshortcuts: shortcut?.ariaKeyshortcuts,
    label: shortcut
      ? `Open workspace in ${preferredTarget.label} (${shortcut.label})`
      : `Open workspace in ${preferredTarget.label}`,
    onSelect: () => {
      void openTarget(preferredTarget, onOpenPreferredTarget);
    },
    content: (
      <WorkspaceOpenTargetIcon
        target={preferredTarget}
        className={cn("size-4", isPending && "animate-shine-icon")}
      />
    ),
  };
  const secondaryActions: SplitButtonAction[] = targets.map((target) => ({
    label: target.label,
    onSelect: () => {
      void openTarget(target, () => onOpenTarget(target.id));
    },
    content: (
      <>
        <WorkspaceOpenTargetIcon target={target} className="size-5" />
        <span className="min-w-0 flex-1">{target.label}</span>
      </>
    ),
  }));

  return (
    <span className="inline-flex items-center gap-1.5">
      <AppCommandShortcutHint shortcut={shortcut} />
      <SplitButton
        disabled={isPending}
        className={cn(
          "border-border/70 bg-transparent px-1 shadow-none",
          CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        )}
        primaryAction={primaryAction}
        primaryTooltip={`Open in ${preferredTarget.label}`}
        secondaryActions={secondaryActions}
        triggerLabel="Choose another app to open workspace"
        triggerTooltip="Choose another app"
        mobileTitle="Open Workspace"
      />
    </span>
  );
}
