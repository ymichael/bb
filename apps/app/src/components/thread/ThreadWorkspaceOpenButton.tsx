import { useCallback, useState } from "react";
import { Check, Code2, FolderOpen, Terminal, Wrench } from "lucide-react";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import { SplitButton, type SplitButtonAction } from "@/components/ui/split-button";
import {
  resolvePreferredWorkspaceOpenTarget,
  useWorkspaceOpenTargetPreference,
} from "@/lib/workspace-open-target-preference";
import { toast } from "sonner";

const WORKSPACE_OPEN_BUTTON_CLASS =
  "h-7 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground";

interface ThreadWorkspaceOpenButtonProps {
  onOpenWorkspace: (targetId: WorkspaceOpenTargetId) => Promise<void>;
  targets: WorkspaceOpenTarget[];
}

interface WorkspaceOpenTargetIconProps {
  target: WorkspaceOpenTarget;
}

function WorkspaceOpenTargetIcon({ target }: WorkspaceOpenTargetIconProps) {
  switch (target.kind) {
    case "file-manager":
      return <FolderOpen className="size-3.5" />;
    case "terminal":
      return <Terminal className="size-3.5" />;
    case "ide":
      return <Wrench className="size-3.5" />;
    case "editor":
      return <Code2 className="size-3.5" />;
    default: {
      const _exhaustive: never = target.kind;
      return _exhaustive;
    }
  }
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
      } catch {
        toast.error(`Could not open workspace in ${target.label}.`);
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
