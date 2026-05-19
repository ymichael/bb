import { useEffect, useState } from "react";
import type { Host } from "@bb/domain";
import type { CreateHostJoinResponse } from "@bb/server-contract";
import { CopyButton } from "@/components/ui/copy-button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Icon } from "@/components/ui/icon.js";

export interface HostJoinDialogProps {
  host: Host | null;
  open: boolean;
  target: CreateHostJoinResponse | null;
  onOpenChange: (open: boolean) => void;
}

function formatExpiresAt(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HostJoinDialog({
  host,
  open,
  target,
  onOpenChange,
}: HostJoinDialogProps) {
  const dialogOpen = open && target !== null;

  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {dialogOpen && target ? (
          <HostJoinDialogContent host={host} target={target} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface HostJoinDialogContentProps {
  host: Host | null;
  target: CreateHostJoinResponse;
}

export function HostJoinDialogContent({
  host,
  target,
}: HostJoinDialogContentProps) {
  const [expired, setExpired] = useState(() => target.expiresAt <= Date.now());
  const connected = host?.status === "connected";
  const waiting = !connected && !expired;
  const statusLabel = connected
    ? "Host connected"
    : expired
      ? "Join command expired"
      : "Waiting for host";

  useEffect(() => {
    const remainingMs = target.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timeoutId = window.setTimeout(() => setExpired(true), remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [target.expiresAt]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>New host</DialogTitle>
        <DialogDescription>
          Run this command from the new host.
        </DialogDescription>
      </DialogHeader>

      <div className="min-w-0 space-y-3">
        <div className="relative min-w-0 rounded-md border border-border bg-surface-recessed">
          <pre className="max-h-56 min-w-0 overflow-y-auto whitespace-pre-wrap break-all px-3 py-2.5 pr-10 text-xs leading-5">
            <code>{target.joinCommand}</code>
          </pre>
          <CopyButton
            text={target.joinCommand}
            label="Copy host command"
            className="absolute right-2 top-2"
          />
        </div>

        <div
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {connected ? (
            <Icon
              name="CircleCheck"
              className="size-4 text-success"
              aria-hidden="true"
            />
          ) : expired ? (
            <Icon
              name="AlertCircle"
              className="size-4 text-destructive"
              aria-hidden="true"
            />
          ) : null}
          <span
            className={
              waiting
                ? "animate-shine font-medium"
                : "font-medium text-foreground"
            }
          >
            {statusLabel}
          </span>
          {waiting ? (
            <span>· Expires at {formatExpiresAt(target.expiresAt)}</span>
          ) : null}
        </div>
      </div>
    </>
  );
}
