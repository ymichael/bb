import { useState } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  ThreadChat,
  useBbContext,
  useBbNavigate,
  type PluginFixedTabRegistration,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";

type DemoThreadTarget = { kind: "thread"; threadId: string };

function isDemoThreadTarget(value: JsonValue): value is DemoThreadTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    value.kind === "thread" &&
    typeof value.threadId === "string" &&
    value.threadId.length > 0
  );
}

function ThreadChatDemoPanel({ subPath }: { subPath: string }) {
  const { threadId: routeThreadId } = useBbContext();
  const [threadId, setThreadId] = useState(subPath);
  const [focusRequest, setFocusRequest] = useState(0);
  const activeThreadId = threadId || routeThreadId || "";
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <input
          className="h-8 flex-1 rounded-md border bg-transparent px-2 text-sm"
          placeholder="Thread id (thr_…)"
          value={threadId}
          onChange={(event) => setThreadId(event.target.value.trim())}
        />
        <button
          type="button"
          className="h-8 cursor-pointer rounded-md border px-2 text-sm hover:bg-surface-recessed"
          onClick={() => setFocusRequest((nonce) => nonce + 1)}
        >
          Focus composer
        </button>
        <button
          type="button"
          disabled={!activeThreadId}
          className="h-8 cursor-pointer rounded-md border px-2 text-sm hover:bg-surface-recessed disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() =>
            panel.openFixedTab({
              surface: { kind: "current" },
              tab: demoThreadFixedTab,
              target: { kind: "thread", threadId: activeThreadId },
            })
          }
        >
          Open compact tab
        </button>
        <button
          type="button"
          className="h-8 cursor-pointer rounded-md border px-2 text-sm hover:bg-surface-recessed"
          onClick={() =>
            navigate.openUrl(
              "https://github.com/get-bb/bb/tree/main/examples/plugins/thread-chat-demo",
            )
          }
        >
          View source
        </button>
      </div>
      {activeThreadId ? (
        <ThreadChat
          threadId={activeThreadId}
          variant="full"
          layout="contained"
          focusRequest={focusRequest}
          className="min-h-0 flex-1"
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          Enter a thread id above (or open the panel from a thread route) to
          render its chat here.
        </p>
      )}
    </div>
  );
}

function DemoThreadFixedTab() {
  const targetState = experimental_useFixedTabTarget(demoThreadFixedTab);
  return targetState === null ? (
    <p className="p-4 text-sm text-muted-foreground">
      Choose “Open compact tab” from the demo page.
    </p>
  ) : (
    <ThreadChat
      key={targetState.sequence}
      threadId={targetState.target.threadId}
      variant="compact"
      className="h-full"
    />
  );
}

const demoThreadFixedTab: PluginFixedTabRegistration<DemoThreadTarget> = {
  panelId: "thread-chat-demo",
  id: "compact-thread",
  title: "Compact thread",
  icon: "PanelRight",
  component: DemoThreadFixedTab,
  layout: "flush",
  experimental_target: { validate: isDemoThreadTarget },
};

interface DemoPanelParams {
  anchorText?: string;
  selectedText?: string;
}

function readDemoPanelParams(params: unknown): DemoPanelParams {
  if (typeof params !== "object" || params === null) return {};
  const record = params as Record<string, unknown>;
  return {
    anchorText:
      typeof record.anchorText === "string" ? record.anchorText : undefined,
    selectedText:
      typeof record.selectedText === "string" ? record.selectedText : undefined,
  };
}

function MessageAnchoredPanel({
  threadId,
  params,
}: {
  threadId: string;
  params: unknown;
}) {
  const { anchorText, selectedText } = readDemoPanelParams(params);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {anchorText ? (
        <div className="shrink-0 border-b p-2 text-xs text-muted-foreground">
          Anchored on: {selectedText ?? anchorText}
        </div>
      ) : null}
      <ThreadChat
        threadId={threadId}
        variant="compact"
        className="min-h-0 flex-1"
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "thread-chat-demo",
    title: "ThreadChat demo",
    icon: "MessageSquarePlus",
    path: "thread-chat",
    component: ThreadChatDemoPanel,
    fixedTabs: [demoThreadFixedTab],
  });
  app.slots.threadPanelAction({
    id: "demo-panel",
    title: "ThreadChat demo panel",
    icon: "MessageSquarePlus",
    component: MessageAnchoredPanel,
    layout: "flush",
  });
  app.slots.messageAction({
    id: "open-in-demo-panel",
    title: "Open in demo panel",
    icon: "MessageSquarePlus",
    run(context) {
      const opened = context.openPanel({
        actionId: "demo-panel",
        title: "Demo panel",
        params: {
          anchorText: context.message.text.slice(0, 200),
          ...(context.selectedText !== undefined
            ? { selectedText: context.selectedText.slice(0, 200) }
            : {}),
        },
      });
      if (!opened) {
        console.warn(
          "thread-chat-demo: this surface has no thread side panel to open",
        );
      }
    },
  });
});
