import { useMemo, type ReactNode } from "react";
import type { PluginPanelActionOpenOptions } from "@get-bb/plugin-sdk";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import {
  usePluginSlots,
  type PluginNewThreadPanelActionSlot,
  type PluginThreadPanelActionSlot,
} from "@/lib/plugin-slots";
import type { PluginPanelFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import {
  parsePersistedPluginPanelParams,
  serializePluginPanelParams,
} from "@/lib/plugin-json-value";
import {
  fileOpenerIdFromActionId,
  parseFileOpenerParams,
} from "./file-opener-tabs";
import { PluginSlotMount } from "./PluginSlotMount";
import { PluginReplacementSlot } from "./PluginReplacementSlot";
import { deprecatedOriginalAlias } from "@/lib/plugin-sdk-deprecated-aliases";
import { resolveReplacement } from "@/lib/plugin-slot-resolvers";

export interface OpenPluginPanelArgs {
  pluginId: string;
  actionId: string;
  title: string;
  paramsJson: string | null;
}

type OpenPluginPanelHandler = (args: OpenPluginPanelArgs) => void;

export interface PluginPanelActionEntry {
  id: string;
  pluginId: string;
  icon: string | null;
  title: string;
  onSelect: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PanelActionOpenPanelArgs {
  action: { pluginId: string; id: string; title: string };
  slot: string;
  openPluginPanel: OpenPluginPanelHandler;
}

function createPanelActionOpenPanel({
  action,
  slot,
  openPluginPanel,
}: PanelActionOpenPanelArgs): (
  options?: PluginPanelActionOpenOptions,
) => boolean {
  return (options) => {
    let paramsJson: string | null;
    try {
      paramsJson = serializePluginPanelParams(options?.params);
    } catch (error) {
      console.warn(
        `[plugin:${action.pluginId}] ${slot} "${action.id}" openPanel declined: ${describeError(error)}`,
      );
      return false;
    }
    openPluginPanel({
      pluginId: action.pluginId,
      actionId: action.id,
      title: options?.title ?? action.title,
      paramsJson,
    });
    return true;
  };
}

interface RunPluginPanelActionArgs {
  action: PluginThreadPanelActionSlot;
  openPluginPanel: OpenPluginPanelHandler;
  threadId: string;
}

function runPluginPanelAction({
  action,
  openPluginPanel,
  threadId,
}: RunPluginPanelActionArgs): void {
  const openPanel = createPanelActionOpenPanel({
    action,
    slot: "threadPanelAction",
    openPluginPanel,
  });
  const warn = (error: unknown) => {
    console.warn(
      `[plugin:${action.pluginId}] threadPanelAction "${action.id}" failed: ${describeError(error)}`,
    );
  };
  try {
    if (action.run === undefined) {
      openPanel();
      return;
    }
    const result = action.run({ threadId, openPanel });
    if (result instanceof Promise) result.catch(warn);
  } catch (error) {
    warn(error);
  }
}

interface RunPluginNewThreadPanelActionArgs {
  action: PluginNewThreadPanelActionSlot;
  openPluginPanel: OpenPluginPanelHandler;
  projectId: string | null;
}

function runPluginNewThreadPanelAction({
  action,
  openPluginPanel,
  projectId,
}: RunPluginNewThreadPanelActionArgs): void {
  const openPanel = createPanelActionOpenPanel({
    action,
    slot: "experimental_newThreadPanelAction",
    openPluginPanel,
  });
  const warn = (error: unknown) => {
    console.warn(
      `[plugin:${action.pluginId}] experimental_newThreadPanelAction "${action.id}" failed: ${describeError(error)}`,
    );
  };
  try {
    if (action.run === undefined) {
      openPanel();
      return;
    }
    const result = action.run({ projectId, openPanel });
    if (result instanceof Promise) result.catch(warn);
  } catch (error) {
    warn(error);
  }
}

export function usePluginPanelActions({
  openPluginPanel,
  threadId,
}: {
  openPluginPanel: OpenPluginPanelHandler;
  threadId: string | null | undefined;
}): readonly PluginPanelActionEntry[] {
  const { threadPanelActions } = usePluginSlots();
  return useMemo(() => {
    if (threadId === null || threadId === undefined || threadId.length === 0) {
      return [];
    }
    return threadPanelActions.map((action) => ({
      id: `plugin-action:${action.pluginId}:${action.id}`,
      pluginId: action.pluginId,
      icon: action.icon ?? null,
      title: action.title,
      onSelect: () =>
        runPluginPanelAction({ action, openPluginPanel, threadId }),
    }));
  }, [openPluginPanel, threadId, threadPanelActions]);
}

export function usePluginNewThreadPanelActions({
  openPluginPanel,
  projectId,
}: {
  openPluginPanel: OpenPluginPanelHandler;
  projectId: string | null;
}): readonly PluginPanelActionEntry[] {
  const { newThreadPanelActions } = usePluginSlots();
  return useMemo(
    () =>
      newThreadPanelActions.map((action) => ({
        id: `plugin-new-thread-action:${action.pluginId}:${action.id}`,
        pluginId: action.pluginId,
        icon: action.icon ?? null,
        title: action.title,
        onSelect: () =>
          runPluginNewThreadPanelAction({
            action,
            openPluginPanel,
            projectId,
          }),
      })),
    [newThreadPanelActions, openPluginPanel, projectId],
  );
}

type PluginPanelSurfaceContext =
  | { kind: "thread"; threadId: string }
  | { kind: "new-thread"; projectId: string | null };

export function PluginPanelTabContent({
  tab,
  context,
  fileOpenerOriginal,
}: {
  tab: PluginPanelFixedPanelTab;
  context: PluginPanelSurfaceContext;
  fileOpenerOriginal?: ReactNode;
}) {
  const openerId = fileOpenerIdFromActionId(tab.actionId);
  if (openerId !== null) {
    return (
      <FileOpenerTabContent
        openerId={openerId}
        original={fileOpenerOriginal}
        tab={tab}
      />
    );
  }
  return context.kind === "thread" ? (
    <ThreadActionTabContent tab={tab} threadId={context.threadId} />
  ) : (
    <NewThreadActionTabContent tab={tab} projectId={context.projectId} />
  );
}

function UnavailableActionTab() {
  return (
    <div className="p-4">
      <EmptyStatePanel className="rounded-lg p-6 text-sm">
        This plugin tab is not available. The plugin may still be loading, or it
        has been disabled or removed.
      </EmptyStatePanel>
    </div>
  );
}

function ThreadActionTabContent({
  tab,
  threadId,
}: {
  tab: PluginPanelFixedPanelTab;
  threadId: string;
}) {
  const { threadPanelActions } = usePluginSlots();
  const action =
    threadPanelActions.find(
      (candidate) =>
        candidate.pluginId === tab.pluginId && candidate.id === tab.actionId,
    ) ?? null;
  const params = useMemo(
    () => parsePersistedPluginPanelParams(tab.paramsJson),
    [tab.paramsJson],
  );
  if (action === null) return <UnavailableActionTab />;
  return (
    <div
      className={
        action.layout === "flush"
          ? "h-full min-h-0 flex-1 overflow-hidden"
          : "h-full min-h-0 flex-1 overflow-y-auto p-4"
      }
      data-testid="plugin-panel-tab-content"
    >
      <PluginSlotMount
        key={`thread/${action.pluginId}/${action.id}/${action.generation}`}
        pluginId={action.pluginId}
        slotKind="threadPanelAction"
        slotId={action.id}
      >
        <action.component threadId={threadId} params={params} />
      </PluginSlotMount>
    </div>
  );
}

function NewThreadActionTabContent({
  tab,
  projectId,
}: {
  tab: PluginPanelFixedPanelTab;
  projectId: string | null;
}) {
  const { newThreadPanelActions } = usePluginSlots();
  const action =
    newThreadPanelActions.find(
      (candidate) =>
        candidate.pluginId === tab.pluginId && candidate.id === tab.actionId,
    ) ?? null;
  const params = useMemo(
    () => parsePersistedPluginPanelParams(tab.paramsJson),
    [tab.paramsJson],
  );
  if (action === null) return <UnavailableActionTab />;
  return (
    <div
      className={
        action.layout === "flush"
          ? "h-full min-h-0 flex-1 overflow-hidden"
          : "h-full min-h-0 flex-1 overflow-y-auto p-4"
      }
      data-testid="plugin-new-thread-panel-tab-content"
    >
      <PluginSlotMount
        key={`new-thread/${action.pluginId}/${action.id}/${action.generation}`}
        pluginId={action.pluginId}
        slotKind="newThreadPanelAction"
        slotId={action.id}
      >
        <action.component projectId={projectId} params={params} />
      </PluginSlotMount>
    </div>
  );
}

function FileOpenerTabContent({
  openerId,
  original,
  tab,
}: {
  openerId: string;
  original: ReactNode | undefined;
  tab: PluginPanelFixedPanelTab;
}) {
  const { fileOpeners } = usePluginSlots();
  const replacement = resolveReplacement(
    fileOpeners,
    (candidate) =>
      candidate.pluginId === tab.pluginId && candidate.id === openerId,
  );
  const file = useMemo(
    () => parseFileOpenerParams(tab.paramsJson),
    [tab.paramsJson],
  );
  if (
    file === null ||
    tab.fileOpenerOwner === undefined ||
    original === undefined
  ) {
    return <UnavailableFileOpenerTab />;
  }
  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind="fileOpener"
    >
      {(opener, BoundOriginal) => (
        <div
          className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
          data-testid="plugin-file-opener-tab-content"
        >
          <opener.component
            path={file.path}
            source={file.source}
            Original={BoundOriginal}
            experimental_Original={deprecatedOriginalAlias(BoundOriginal)}
          />
        </div>
      )}
    </PluginReplacementSlot>
  );
}

function UnavailableFileOpenerTab() {
  return (
    <div className="p-4">
      <EmptyStatePanel className="rounded-lg p-6 text-sm">
        This file opener is not available. The plugin may still be loading, or
        it has been disabled or removed — reopen the file to use the built-in
        preview.
      </EmptyStatePanel>
    </div>
  );
}
