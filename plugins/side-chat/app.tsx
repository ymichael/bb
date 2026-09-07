import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@bb/shared-ui/icon";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  useRpc,
  type PluginMessageActionContext,
  type PluginThreadPanelActionContext,
  type PluginThreadPanelProps,
  type ThreadChatMessageAction,
} from "@get-bb/plugin-sdk/app";
import type { sideChatRpcContract } from "./server.js";

const PLUGIN_ID = "side-chat";
const PANEL_ACTION_ID = "side-chat";

const PANEL_TAB_TITLE = "Side chat";

type SideChatPanelParams = {
  threadId: string;
  sourceThreadId: string;
  sourceMessageText: string;
  sourceSeqEnd: number | null;
};

export function parsePanelParams(value: unknown): SideChatPanelParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    record.threadId.length === 0 ||
    typeof record.sourceThreadId !== "string" ||
    record.sourceThreadId.length === 0
  ) {
    return null;
  }
  return {
    threadId: record.threadId,
    sourceThreadId: record.sourceThreadId,
    sourceMessageText:
      typeof record.sourceMessageText === "string"
        ? record.sourceMessageText
        : "",
    sourceSeqEnd:
      typeof record.sourceSeqEnd === "number" ? record.sourceSeqEnd : null,
  };
}

async function callBackendRpc(
  method: string,
  input: unknown,
): Promise<unknown> {
  const response = await fetch(
    `/api/v1/plugins/${PLUGIN_ID}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? null),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || body?.ok !== true) {
    const structuredMessage =
      typeof body?.error === "object" &&
      body.error !== null &&
      typeof (body.error as { message?: unknown }).message === "string"
        ? String((body.error as { message: string }).message)
        : null;
    throw new Error(
      structuredMessage ?? `rpc "${method}" failed (HTTP ${response.status})`,
    );
  }
  return body.result;
}

function createdThreadId(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { threadId?: unknown }).threadId === "string"
  ) {
    return (result as { threadId: string }).threadId;
  }
  throw new Error("Plugin returned an unexpected createSideChat response.");
}

interface OpenSideChatArgs {
  sourceThreadId: string;
  anchorText: string;
  sourceSeqEnd: number | null;
  openPanel(options: { title: string; params: SideChatPanelParams }): boolean;
}

const inFlightOpens = new Map<string, Promise<void>>();

function openKey({
  sourceThreadId,
  anchorText,
  sourceSeqEnd,
}: Pick<
  OpenSideChatArgs,
  "sourceThreadId" | "anchorText" | "sourceSeqEnd"
>): string {
  return `${sourceThreadId}|${sourceSeqEnd ?? "tip"}|${anchorText}`;
}

function openSideChat(args: OpenSideChatArgs): Promise<void> {
  const key = openKey(args);
  const pending = inFlightOpens.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const run = createAndOpenSideChat(args);
  inFlightOpens.set(key, run);
  run.then(
    () => inFlightOpens.delete(key),
    () => inFlightOpens.delete(key),
  );
  return run;
}

async function createAndOpenSideChat({
  sourceThreadId,
  anchorText,
  sourceSeqEnd,
  openPanel,
}: OpenSideChatArgs): Promise<void> {
  let threadId: string;
  try {
    threadId = createdThreadId(
      await callBackendRpc("createSideChat", {
        sourceThreadId,
        ...(sourceSeqEnd !== null ? { sourceSeqEnd } : {}),
        anchorText,
      }),
    );
  } catch (error) {
    toast.error(
      `Failed to start side chat: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
  openPanel({
    title: PANEL_TAB_TITLE,
    params: {
      threadId,
      sourceThreadId,
      sourceMessageText: anchorText,
      sourceSeqEnd,
    },
  });
}

function ReplyingTo({ anchorText }: { anchorText: string }) {
  const trimmed = anchorText.trim();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (node !== null) {
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    }
  }, []);
  if (trimmed.length === 0) {
    return null;
  }
  const clamped = !expanded;
  return (
    <div className="mx-1 mb-2 flex flex-col items-start gap-1">
      <span className="text-xs leading-none text-muted-foreground">
        <Icon
          name="CornerDownRight"
          className="mr-1 inline-block size-3 align-middle"
        />
        Replying to
      </span>
      <div
        className={`max-w-full rounded-md bg-surface-recessed p-1.5 text-xs leading-5 text-foreground ${
          overflows ? "cursor-pointer" : ""
        }`}
        role={overflows ? "button" : undefined}
        title={
          overflows ? (expanded ? "Collapse" : "Show full message") : undefined
        }
        onClick={overflows ? () => setExpanded((value) => !value) : undefined}
      >
        <div
          ref={measureRef}
          className={
            clamped
              ? "max-h-20 overflow-hidden break-words " +
                (overflows
                  ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.25rem),transparent)]"
                  : "")
              : "break-words"
          }
        >
          <Markdown
            content={trimmed}
            className="text-xs leading-5 [&_blockquote]:my-1 [&_h1]:mb-1 [&_h1]:mt-0 [&_h1]:text-sm [&_h2]:mb-1 [&_h2]:mt-0 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-0 [&_h3]:text-xs [&_li]:mb-0 [&_ol]:mb-1 [&_p]:mb-1 [&_ul]:mb-1"
          />
        </div>
      </div>
    </div>
  );
}

function SideChatPanel({ params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof sideChatRpcContract>();
  const parsed = parsePanelParams(params);
  const sideChatThreadId = parsed?.threadId ?? null;
  const sourceThreadId = parsed?.sourceThreadId ?? null;

  const sendToMain = useCallback(
    async (message: { text: string; threadId: string }) => {
      if (sourceThreadId === null || sideChatThreadId === null) return;
      try {
        await rpc.call("sendToMain", {
          sourceThreadId,
          senderThreadId: sideChatThreadId,
          text: message.text,
        });
        toast.success("Sent to main thread");
      } catch (error) {
        toast.error(
          `Failed to send to main thread: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    [rpc, sideChatThreadId, sourceThreadId],
  );

  if (parsed === null) {
    return (
      <div className="p-3 text-sm text-muted-foreground" role="alert">
        This side chat tab is missing its thread reference.
      </div>
    );
  }

  const messageActions: ThreadChatMessageAction[] = [
    {
      id: "send-to-main",
      title: "Send to main thread",
      icon: "ArrowTurnBackward",
      roles: ["assistant"],
      run: (message) => sendToMain(message),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadChat
        threadId={parsed.threadId}
        variant="compact"
        layout="contained"
        permissionPolicy="editable"
        className="min-h-0 flex-1"
        leadingContent={<ReplyingTo anchorText={parsed.sourceMessageText} />}
        messageActions={messageActions}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "reply-in-side-chat",
    title: "Reply in side chat",
    icon: "SideChat",
    async run(context: PluginMessageActionContext) {
      const anchorText = context.selectedText ?? context.message.text;
      await openSideChat({
        sourceThreadId: context.threadId,
        anchorText,
        sourceSeqEnd: context.message.sourceSeqEnd,
        openPanel: (options) =>
          context.openPanel({ actionId: PANEL_ACTION_ID, ...options }),
      });
    },
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Start side chat",
    icon: "SideChat",
    component: SideChatPanel,
    layout: "flush",
    async run(context: PluginThreadPanelActionContext) {
      await openSideChat({
        sourceThreadId: context.threadId,
        anchorText: "",
        sourceSeqEnd: null,
        openPanel: (options) => context.openPanel(options),
      });
    },
  });
});
