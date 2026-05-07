import { useCallback, useState } from "react";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import vscodeIcon from "@/assets/workspace-open-target-icons/vscode.png";
import cursorIcon from "@/assets/workspace-open-target-icons/cursor.png";
import sublimeTextIcon from "@/assets/workspace-open-target-icons/sublime-text.png";
import zedIcon from "@/assets/workspace-open-target-icons/zed.png";
import windsurfIcon from "@/assets/workspace-open-target-icons/windsurf.png";
import antigravityIcon from "@/assets/workspace-open-target-icons/antigravity.png";
import finderIcon from "@/assets/workspace-open-target-icons/finder.png";
import terminalIcon from "@/assets/workspace-open-target-icons/terminal.png";
import iterm2Icon from "@/assets/workspace-open-target-icons/iterm2.png";
import ghosttyIcon from "@/assets/workspace-open-target-icons/ghostty.png";
import xcodeIcon from "@/assets/workspace-open-target-icons/xcode.png";
import { SplitButton, type SplitButtonAction } from "@/components/ui";

const WORKSPACE_OPEN_TARGET_ICONS: Record<WorkspaceOpenTargetId, string> = {
  vscode: vscodeIcon,
  cursor: cursorIcon,
  "sublime-text": sublimeTextIcon,
  zed: zedIcon,
  windsurf: windsurfIcon,
  antigravity: antigravityIcon,
  finder: finderIcon,
  terminal: terminalIcon,
  iterm2: iterm2Icon,
  ghostty: ghosttyIcon,
  xcode: xcodeIcon,
};

interface ThreadWorkspaceOpenButtonProps {
  onOpenPreferredTarget: () => Promise<void>;
  onOpenTarget: (targetId: WorkspaceOpenTargetId) => Promise<void>;
  preferredTarget: WorkspaceOpenTarget | null;
  targets: WorkspaceOpenTarget[];
}

interface WorkspaceOpenTargetIconProps {
  target: WorkspaceOpenTarget;
  className?: string;
}

function WorkspaceOpenTargetIcon({
  target,
  className = "size-4",
}: WorkspaceOpenTargetIconProps) {
  return (
    <img
      alt=""
      className={`${className} shrink-0 rounded-[3px]`}
      draggable={false}
      src={WORKSPACE_OPEN_TARGET_ICONS[target.id]}
    />
  );
}

export function ThreadWorkspaceOpenButton({
  onOpenPreferredTarget,
  onOpenTarget,
  preferredTarget,
  targets,
}: ThreadWorkspaceOpenButtonProps) {
  const [pendingTargetId, setPendingTargetId] =
    useState<WorkspaceOpenTargetId | null>(null);
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
    label: `Open workspace in ${preferredTarget.label}`,
    onSelect: () => {
      void openTarget(preferredTarget, onOpenPreferredTarget);
    },
    content: (
      <WorkspaceOpenTargetIcon target={preferredTarget} className="size-5" />
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
    <SplitButton
      disabled={isPending}
      className="px-1"
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
      triggerLabel="Choose workspace open target"
      mobileTitle="Open Workspace"
    />
  );
}
