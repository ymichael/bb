import { useCallback, useContext, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ThreadChatMessageAction,
  ThreadChatProps,
} from "@get-bb/plugin-sdk";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import { EmbeddedThreadChat } from "@/components/thread/embedded-chat";
import {
  ThreadTimelinePanelContent,
  type ThreadTimelineConsumerMessageAction,
} from "@/components/thread/timeline";
import { useThreadTimelineNavigation } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { PluginContext } from "@/components/plugin/plugin-context";
import { ThreadProviderContext } from "@/components/thread/thread-provider-context";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemProviderInfo } from "@/hooks/queries/system-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getEnvironmentWorkspaceSummaryDisplay } from "@/lib/environment-workspace-display";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { BbHttpError } from "@/lib/sdk";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";

export function PluginThreadChat({
  threadId,
  variant = "full",
  layout = "contained",
  focusRequest,
  permissionPolicy = "inherit",
  className,
  leadingContent,
  messageActions,
}: ThreadChatProps) {
  const containerClassName = cn(
    layout === "contained" ? "flex h-full min-h-0 flex-col" : "flex flex-col",
    className,
  );
  return (
    <div className={containerClassName}>
      <PluginThreadChatBody
        threadId={threadId}
        variant={variant}
        layout={layout}
        focusRequest={focusRequest}
        permissionPolicy={permissionPolicy}
        leadingContent={leadingContent}
        messageActions={messageActions}
      />
    </div>
  );
}

interface PluginThreadChatBodyProps {
  threadId: string;
  variant: "full" | "compact" | "timeline";
  layout: "contained" | "document";
  focusRequest: number | undefined;
  permissionPolicy: "inherit" | "editable";
  leadingContent: ReactNode;
  messageActions: readonly ThreadChatMessageAction[] | undefined;
}

function PluginThreadChatBody({
  threadId,
  variant,
  layout,
  focusRequest,
  permissionPolicy,
  leadingContent,
  messageActions,
}: PluginThreadChatBodyProps) {
  const threadQuery = useThread(threadId, { enabled: threadId.length > 0 });
  const thread = threadQuery.data;
  const threadProviderInfo = useSystemProviderInfo(
    thread?.environmentId
      ? {
          enabled: true,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        }
      : {
          enabled: thread !== undefined,
          providerId: thread?.providerId,
        },
  );
  const threadProviderPluginId = threadProviderInfo?.pluginId ?? null;
  const threadProviderContextValue = useMemo(
    () => ({
      providerId: thread?.providerId ?? null,
      pluginId: threadProviderPluginId,
    }),
    [thread?.providerId, threadProviderPluginId],
  );
  const navigate = useNavigate();
  const { isLocalDaemonHost } = useHostDaemon();
  const environmentQuery = useEnvironment(thread?.environmentId ?? null);
  const environment = environmentQuery.data ?? null;
  const hostsQuery = useHosts({ enabled: environment !== null });
  const environmentHostName = environment
    ? (hostsQuery.data?.find((host) => host.id === environment.hostId)?.name ??
      null)
    : null;
  const timelineNavigation = useThreadTimelineNavigation();
  const canUseHostFileNavigation =
    thread !== undefined &&
    thread.environmentId === timelineNavigation?.environmentId;
  const onOpenLink = timelineNavigation?.onOpenLink;
  const onOpenLocalFileLink = canUseHostFileNavigation
    ? timelineNavigation.onOpenLocalFileLink
    : undefined;
  const resolveHostMentionLink = canUseHostFileNavigation
    ? timelineNavigation.resolveMentionLink
    : undefined;
  const workspaceRootPath =
    environment?.path ??
    (canUseHostFileNavigation
      ? timelineNavigation.workspaceRootPath
      : undefined);
  const pluginId = useContext(PluginContext);
  const consumerMessageActions = useMemo<
    readonly ThreadTimelineConsumerMessageAction[] | undefined
  >(
    () =>
      messageActions === undefined || messageActions.length === 0
        ? undefined
        : messageActions.map((action) => ({
            id: action.id,
            pluginId: action.icon !== undefined ? null : pluginId,
            icon: action.icon ?? null,
            label: action.title,
            ...(action.roles !== undefined ? { roles: action.roles } : {}),
            run: action.run,
          })),
    [messageActions, pluginId],
  );

  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? thread?.projectId;
        if (targetProjectId === undefined) return null;
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      if (
        resource.kind === "path" &&
        resource.entryKind === "file" &&
        resource.source === "workspace"
      ) {
        return resolveHostMentionLink?.(resource) ?? null;
      }
      return null;
    },
    [navigate, resolveHostMentionLink, thread?.projectId],
  );

  const environmentSummary = useMemo(() => {
    if (environment === null) {
      return null;
    }
    const host: EnvironmentDisplayHostContext = {
      locality: isLocalDaemonHost(environment.hostId) ? "local" : "remote",
      identity: null,
    };
    const display = formatEnvironmentDisplay({ environment, host });
    const summaryDisplay = getEnvironmentWorkspaceSummaryDisplay({
      display,
      environmentName: environment.name,
      locality: host.locality,
      hostName: environmentHostName ?? undefined,
    });
    return (
      <ThreadEnvironmentSummary
        environmentLabel={summaryDisplay.label}
        environmentCompactLabel={summaryDisplay.compactLabel}
        environmentIcon={summaryDisplay.icon}
        environmentTypeLabel={summaryDisplay.typeLabel}
        environmentCheckout={
          environment.branchName
            ? formatWorkspaceCheckoutDisplay({
                checkout: {
                  kind: "branch",
                  branchName: environment.branchName,
                  headSha: null,
                },
              })
            : undefined
        }
      />
    );
  }, [environment, environmentHostName, isLocalDaemonHost]);

  const isThreadMissing =
    threadQuery.error instanceof BbHttpError &&
    threadQuery.error.status === 404;
  if (isThreadMissing) {
    return (
      <EmptyStatePanel className="m-2 rounded-lg">
        This thread is no longer available.
      </EmptyStatePanel>
    );
  }
  if (thread === undefined) {
    return (
      <div className="space-y-2 px-4 pt-4">
        <Skeleton className="h-4 w-3/4 rounded-sm" />
        <Skeleton className="h-4 w-2/3 rounded-sm" />
        <Skeleton className="h-4 w-1/2 rounded-sm" />
      </div>
    );
  }

  if (variant === "timeline") {
    const transcript = (
      <ThreadTimelinePanelContent
        leadingContent={leadingContent}
        consumerMessageActions={consumerMessageActions}
        includePluginMessageActions={false}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={thread.projectId}
        resolveMentionLink={resolveMentionLink}
        surfaceKey={`plugin-thread-chat:${threadId}`}
        threadId={threadId}
        workspaceRootPath={workspaceRootPath}
      />
    );
    return (
      <ThreadProviderContext.Provider value={threadProviderContextValue}>
        {layout === "contained" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-background px-2 pb-3 pt-3">
            {transcript}
          </div>
        ) : (
          <div className="bg-background px-2 pb-3 pt-3">{transcript}</div>
        )}
      </ThreadProviderContext.Provider>
    );
  }

  return (
    <ThreadProviderContext.Provider value={threadProviderContextValue}>
      <EmbeddedThreadChat
        variant="compact"
        layout={layout}
        measure={variant === "full" ? "page" : "panel"}
        surfaceTone={variant === "compact" ? "sidebar" : "background"}
        threadId={threadId}
        projectId={thread.projectId}
        providerId={thread.providerId}
        promptContextEnvironmentId={thread.environmentId}
        resolveMentionLink={resolveMentionLink}
        leadingContent={leadingContent}
        consumerMessageActions={consumerMessageActions}
        includePluginMessageActions={false}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        workspaceRootPath={workspaceRootPath}
        composer={{
          draftScope: {
            kind: "thread",
            projectId: thread.projectId,
            threadId,
          },
          executionDefaultsThreadId: threadId,
          executionResetKey: threadId,
          executionEnvironmentId: thread.environmentId ?? undefined,
          executionEnvironmentHostId: environment?.hostId,
          permissionPolicy:
            permissionPolicy === "editable" ? "editable" : "snapshot",
          environmentSummary,
          pluginComposerBottomScope: { kind: "thread", threadId },
          composerIdentity: `plugin-thread-chat:${threadId}`,
          focusRequestKey: focusRequest,
        }}
      />
    </ThreadProviderContext.Provider>
  );
}
