import { useEffect, useState } from "react";
import type { Attachment } from "../../shared/contract.js";
import { formatFileSize } from "../activity/time.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Icon } from "@bb/shared-ui/icon";

export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/v1/plugins/tasks/http/attachments/download?attachmentId=${encodeURIComponent(attachmentId)}`;
}

let tokenPromise: Promise<string> | null = null;

function pluginToken(): Promise<string> {
  tokenPromise ??= (async () => {
    const response = await fetch("/api/v1/plugins/tasks/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const json: unknown = await response.json().catch(() => null);
    const token =
      json && typeof json === "object" && "token" in json
        ? (json as { token: unknown }).token
        : undefined;
    if (!response.ok || typeof token !== "string") {
      throw new Error(`failed to fetch plugin token (HTTP ${response.status})`);
    }
    return token;
  })();
  tokenPromise.catch(() => {
    tokenPromise = null;
  });
  return tokenPromise;
}

export type AttachmentOwnerRef = { taskId: string } | { commentId: string };

export async function uploadAttachment(
  file: File,
  owner: AttachmentOwnerRef,
): Promise<{ attachmentId: string; url: string }> {
  const token = await pluginToken();
  const query = new URLSearchParams({
    ...owner,
    fileName: file.name || "attachment",
    mime: file.type || "application/octet-stream",
  });
  const response = await fetch(
    `/api/v1/plugins/tasks/http/attachments/upload?${query.toString()}`,
    {
      method: "POST",
      headers: { "x-bb-plugin-token": token },
      body: file,
    },
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `upload failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  const result = json as { attachmentId: string; url: string };
  return { attachmentId: result.attachmentId, url: result.url };
}

export function Lightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label={attachment.fileName}
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: "color-mix(in oklab, var(--ink) 60%, transparent)" }}
      onClick={onClose}
    >
      <img
        src={attachmentDownloadUrl(attachment.id)}
        alt={attachment.fileName}
        className="max-h-full max-w-full rounded-md shadow-md"
        onClick={(event) => event.stopPropagation()}
      />
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md bg-popover/90 px-3 py-1.5 text-xs text-popover-foreground shadow-md">
        <span className="max-w-72 truncate">{attachment.fileName}</span>
        <span className="text-muted-foreground">
          {formatFileSize(attachment.sizeBytes)}
        </span>
      </div>
      <button
        type="button"
        aria-label="Close"
        className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-md bg-popover/90 text-popover-foreground shadow-md hover:bg-popover"
        onClick={onClose}
      >
        <Icon name="X" className="size-4" />
      </button>
    </div>
  );
}

function RemovalSpinner() {
  return (
    <span
      role="status"
      aria-label="Removing"
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function AttachmentsGrid({
  attachments,
  onRemove,
  onError,
}: {
  attachments: Attachment[];
  onRemove?: (attachment: Attachment) => Promise<void>;
  onError?: (message: string) => void;
}) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [confirm, setConfirm] = useState<Attachment | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const removable = onRemove !== undefined;

  const requestRemove = (attachment: Attachment) => setConfirm(attachment);

  const performRemove = async (attachment: Attachment) => {
    setConfirm(null);
    setLightbox((current) => (current?.id === attachment.id ? null : current));
    setPending((current) => new Set(current).add(attachment.id));
    try {
      await onRemove?.(attachment);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(attachment.id);
        return next;
      });
    }
  };

  if (attachments.length === 0) return null;

  const files = attachments.filter((attachment) => !attachment.isImage);
  const images = attachments.filter((attachment) => attachment.isImage);

  const removeButton = (attachment: Attachment, variant: "image" | "file") => {
    if (!removable) return null;
    const busy = pending.has(attachment.id);
    const base =
      variant === "image"
        ? "absolute right-1 top-1 z-10 rounded-full bg-black/55 p-0.5 text-white transition-colors hover:bg-black/70 disabled:opacity-70"
        : "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-70";
    return (
      <button
        type="button"
        aria-label={`Remove ${attachment.fileName}`}
        disabled={busy}
        className={base}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) requestRemove(attachment);
        }}
      >
        {busy ? <RemovalSpinner /> : <Icon name="X" className="size-3" />}
      </button>
    );
  };

  const fileCard = (attachment: Attachment) => (
    <div
      key={attachment.id}
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm shadow-2xs"
    >
      <a
        href={attachmentDownloadUrl(attachment.id)}
        download={attachment.fileName}
        className="flex min-w-0 items-center gap-2 rounded-sm hover:bg-state-hover"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground">
          <Icon name="File" className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block max-w-48 truncate">{attachment.fileName}</span>
          <span className="block text-2xs text-muted-foreground">
            {formatFileSize(attachment.sizeBytes)}
          </span>
        </span>
      </a>
      {removeButton(attachment, "file")}
    </div>
  );

  const imageTile = (attachment: Attachment) => (
    <div
      key={attachment.id}
      className="group relative overflow-hidden rounded-md border border-border shadow-2xs"
    >
      <button
        type="button"
        className="block"
        title={`${attachment.fileName} · ${formatFileSize(attachment.sizeBytes)}`}
        onClick={() => setLightbox(attachment)}
      >
        <img
          src={attachmentDownloadUrl(attachment.id)}
          alt={attachment.fileName}
          className="block h-24 w-36 object-cover transition-opacity group-hover:opacity-90"
        />
        <span
          className="absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-left text-2xs opacity-0 transition-opacity group-hover:opacity-100"
          style={{
            background: "color-mix(in oklab, var(--ink) 55%, transparent)",
            color: "var(--canvas)",
          }}
        >
          {attachment.fileName}
        </span>
      </button>
      {removeButton(attachment, "image")}
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2">
          {files.map(fileCard)}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2">
          {images.map(imageTile)}
        </div>
      ) : null}
      {lightbox ? (
        <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Remove attachment?"
        description={
          confirm
            ? `"${confirm.fileName}" will be permanently removed. Any references in the task description will be removed too. This cannot be undone.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          if (confirm) void performRemove(confirm);
        }}
      />
    </div>
  );
}
