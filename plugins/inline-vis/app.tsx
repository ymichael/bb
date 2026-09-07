import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  definePluginApp,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { inlineVisRpcContract } from "./server.js";

type LoadState =
  | { status: "missing-file" }
  | { status: "invalid-height"; message: string }
  | { status: "loading"; file: string }
  | { status: "ready"; file: string }
  | { status: "error"; file: string; message: string };

const DEFAULT_HEIGHT_PX = 224;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 1_200;

function encodePathSegments(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

function buildWorktreePreviewUrl(threadId: string, file: string): string {
  return `/api/v1/threads/${encodeURIComponent(threadId)}/worktree/files/${encodePathSegments(file)}`;
}

function parsePreviewHeight(value: string | undefined): number | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) return DEFAULT_HEIGHT_PX;
  if (!/^\d+$/.test(normalized)) return null;
  const height = Number(normalized);
  return Number.isSafeInteger(height) &&
    height >= MIN_HEIGHT_PX &&
    height <= MAX_HEIGHT_PX
    ? height
    : null;
}

function PreviewCard({
  file,
  action,
  children,
}: {
  file: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-semibold">inline-vis</span>
          <span className="truncate opacity-70">{file}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function InlineVisDirective({
  attributes,
  source,
  message,
  openWorkspaceFile,
}: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof inlineVisRpcContract>();
  const fileAttr = attributes.file?.trim() ?? "";
  const heightAttr = attributes.height;
  const previewHeight = parsePreviewHeight(heightAttr);
  const heightError =
    previewHeight === null
      ? `inline-vis height must be a whole number from ${MIN_HEIGHT_PX} to ${MAX_HEIGHT_PX} pixels.`
      : null;
  const [state, setState] = useState<LoadState>(() =>
    heightError
      ? { status: "invalid-height", message: heightError }
      : fileAttr
        ? { status: "loading", file: fileAttr }
        : { status: "missing-file" },
  );

  useEffect(() => {
    if (heightError) {
      setState({ status: "invalid-height", message: heightError });
      return;
    }
    if (!fileAttr) {
      setState({ status: "missing-file" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", file: fileAttr });

    void (async () => {
      try {
        const result = await rpc.call("prepareHtmlPreview", {
          threadId: message.threadId,
          file: fileAttr,
        });
        if (cancelled) return;
        setState({
          status: "ready",
          file: result.file,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          file: fileAttr,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileAttr, heightError, message.threadId, rpc]);

  if (state.status === "missing-file") {
    return (
      <div
        role="alert"
        className="my-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        title={source}
      >
        inline-vis requires a file attribute, e.g.{" "}
        <code>::inline-vis{'{file="demo.html"}'}</code>
      </div>
    );
  }

  if (state.status === "invalid-height") {
    return (
      <div
        role="alert"
        className="my-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        title={source}
      >
        {state.message}
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <PreviewCard
        file={state.file}
        action={
          openWorkspaceFile === null ? null : (
            <span aria-hidden className="size-5 shrink-0" />
          )
        }
      >
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading visualization ${state.file}`}
          style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
          className="w-full p-3"
        >
          <Skeleton className="size-full" />
        </div>
      </PreviewCard>
    );
  }

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="my-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        title={source}
      >
        Failed to load {state.file}: {state.message}
      </div>
    );
  }

  const previewUrl = buildWorktreePreviewUrl(message.threadId, state.file);

  return (
    <PreviewCard
      file={state.file}
      action={
        openWorkspaceFile === null ? null : (
          <button
            type="button"
            aria-label={`Open ${state.file} in sidebar`}
            title="Open in sidebar"
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => {
              openWorkspaceFile(state.file);
            }}
          >
            <Icon name="ExternalLink" aria-hidden className="size-3" />
          </button>
        )
      }
    >
      <iframe
        title={`inline-vis: ${state.file}`}
        src={previewUrl}
        sandbox="allow-scripts"
        style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
        className="block w-full border-0 bg-background"
      />
    </PreviewCard>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({
    id: "inline-vis",
    component: InlineVisDirective,
  });
});
