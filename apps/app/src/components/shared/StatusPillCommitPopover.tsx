import { useState } from "react";
import type { ThreadWorkStatus } from "@beanbag/agent-core";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill, type StatusPillVariant } from "./StatusPill";

export function StatusPillCommitPopover({
  status,
  label,
  variant,
  canCommit,
  isCommitting,
  onCommit,
}: {
  status: ThreadWorkStatus | undefined;
  label: string;
  variant: StatusPillVariant;
  canCommit: boolean;
  isCommitting: boolean;
  onCommit: (args: { includeUnstaged: boolean; message?: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");

  if (!canCommit) {
    return <StatusPill variant={variant}>{label}</StatusPill>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-sm">
          <StatusPill variant={variant}>{label}</StatusPill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px]">
        <div className="space-y-3 text-sm">
          <h3 className="text-base font-semibold">Commit your changes</h3>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Branch</span>
            <span className="font-medium">
              {status?.currentBranch ?? status?.defaultBranch ?? "unknown"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Changes</span>
            <span className="font-medium">
              {status?.workspaceChangedFiles ?? 0} files +{status?.workspaceInsertions ?? 0} -
              {status?.workspaceDeletions ?? 0}
            </span>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeUnstaged}
              onChange={(event) => setIncludeUnstaged(event.target.checked)}
            />
            Include unstaged
          </label>
          <div className="space-y-1">
            <label className="text-muted-foreground">Commit message</label>
            <Textarea
              rows={3}
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Leave blank to autogenerate a commit message"
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={!canCommit || isCommitting}
              onClick={async () => {
                await onCommit({
                  includeUnstaged,
                  message: commitMessage.trim() || undefined,
                });
                setOpen(false);
                setCommitMessage("");
              }}
            >
              {isCommitting ? "Committing..." : "Commit changes"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
