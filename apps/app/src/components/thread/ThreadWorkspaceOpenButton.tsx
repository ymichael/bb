import { useCallback, useState } from "react";
import { Check } from "lucide-react";
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
import { SplitButton, type SplitButtonAction } from "@/components/ui/split-button";
import {
  resolvePreferredWorkspaceOpenTarget,
  useWorkspaceOpenTargetPreference,
} from "@/lib/workspace-open-target-preference";
import { toast } from "sonner";

const WORKSPACE_OPEN_BUTTON_CLASS =
  "h-7 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground";

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
  onOpenWorkspace: (targetId: WorkspaceOpenTargetId) => Promise<void>;
  targets: WorkspaceOpenTarget[];
}

interface WorkspaceOpenTargetIconProps {
  target: WorkspaceOpenTarget;
}

function WorkspaceOpenTargetIcon({ target }: WorkspaceOpenTargetIconProps) {
  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-[3px]"
      draggable={false}
      src={WORKSPACE_OPEN_TARGET_ICONS[target.id]}
    />
  );
}

export function ThreadWorkspaceOpenButton({
  onOpenWorkspace,
  targets,
}: ThreadWorkspaceOpenButtonProps) {
  const [preferredTargetId, setPreferredTargetId] = useWorkspaceOpenTargetPreference();
  const [pendingTargetId, setPendingTargetId] = useState<WorkspaceOpenTargetId | null>(null);
  const selectedTarget = resolvePreferredWorkspaceOpenTarget({
    preferredTargetId,
    targets,
  });
  const isPending = pendingTargetId !== null;

  const openTarget = useCallback(
    async (target: WorkspaceOpenTarget, storePreference: boolean) => {
      if (pendingTargetId !== null) {
        return;
      }

      if (storePreference) {
        setPreferredTargetId(target.id);
      }

      setPendingTargetId(target.id);
      try {
        await onOpenWorkspace(target.id);
      } catch (error) {
        toast.error(`Could not open workspace in ${target.label}.`, {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        setPendingTargetId(null);
      }
    },
    [onOpenWorkspace, pendingTargetId, setPreferredTargetId],
  );

  if (!selectedTarget) {
    return null;
  }

  const primaryAction: SplitButtonAction = {
    label: `Open workspace in ${selectedTarget.label}`,
    onSelect: () => {
      void openTarget(selectedTarget, false);
    },
    content: <WorkspaceOpenTargetIcon target={selectedTarget} />,
  };
  const secondaryActions: SplitButtonAction[] = targets.map((target) => ({
    label: target.label,
    onSelect: () => {
      void openTarget(target, true);
    },
    content: (
      <>
        <WorkspaceOpenTargetIcon target={target} />
        <span className="min-w-0 flex-1">{target.label}</span>
        {target.id === selectedTarget.id ? <Check className="size-3.5" /> : null}
      </>
    ),
  }));

  return (
    <SplitButton
      variant="outline"
      size="sm"
      disabled={isPending}
      className={WORKSPACE_OPEN_BUTTON_CLASS}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
      triggerLabel="Choose workspace open target"
      mobileTitle="Open Workspace"
    />
  );
}
