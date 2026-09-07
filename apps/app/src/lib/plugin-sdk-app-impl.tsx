import { useCallback, useMemo } from "react";
import type { MarkdownProps, PluginSdkApp } from "@get-bb/plugin-sdk";
import { PluginDiff } from "@/components/plugin/PluginDiff";
import { PluginNewThreadComposer } from "@/components/plugin/PluginNewThreadComposer";
import { PluginProviderModelPicker } from "@/components/plugin/PluginProviderModelPicker";
import { PluginPermissionModePicker } from "@/components/plugin/PluginPermissionModePicker";
import { PluginSourceCode } from "@/components/plugin/PluginSourceCode";
import { PluginThreadChat } from "@/components/plugin/PluginThreadChat";
import { PluginUrlLink } from "@/components/plugin/PluginUrlLink";
import { ExperimentalFileLink } from "@/components/plugin/ExperimentalFileLink";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import type {
  MarkdownLinkRouting,
  MarkdownLocalFileLinkRouting,
} from "@/components/ui/markdown-link-routing";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import { useThreadTimelineNavigation } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { definePluginApp } from "./plugin-app-definition";
import { installDeprecatedAliases } from "./plugin-sdk-deprecated-aliases";
import {
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
} from "./plugin-sdk-hooks";
import {
  useSidebarThreadActions,
  useSidebarThreadPullRequest,
  useSidebarThreads,
} from "./plugin-sidebar-hooks";
import { useSidebarThreadSplit } from "./plugin-sidebar-split";
import { useAppNavigationHost } from "./app-navigation-host";
import { useCodeTheme } from "./plugin-code-theme";

export const pluginSdkAppImplementation = installDeprecatedAliases(
  {
    definePluginApp,
    useBbContext,
    useBbNavigate,
    experimental_useAppPanel,
    experimental_useFixedTabTarget,
    useComposer,
    useComposerView,
    useRealtime,
    useRealtimeConnectionState,
    useRpc,
    useSettings,
    ThreadChat: PluginThreadChat,
    Markdown: PluginMarkdown,
    experimental_FileLink: ExperimentalFileLink,
    UrlLink: PluginUrlLink,
    experimental_NewThreadComposer: PluginNewThreadComposer,
    experimental_ProviderModelPicker: PluginProviderModelPicker,
    experimental_PermissionModePicker: PluginPermissionModePicker,
    experimental_SourceCode: PluginSourceCode,
    experimental_Diff: PluginDiff,
    experimental_useSidebarThreads: useSidebarThreads,
    experimental_useSidebarThreadActions: useSidebarThreadActions,
    experimental_useSidebarThreadPullRequest: useSidebarThreadPullRequest,
    experimental_useSidebarThreadSplit: useSidebarThreadSplit,
    experimental_useProviders: useProviders,
    experimental_useCodeTheme: useCodeTheme,
  } satisfies PluginSdkApp,
  { experimental_UrlLink: "UrlLink" },
);

function PluginMarkdown({ content, className }: MarkdownProps) {
  const timelineNavigation = useThreadTimelineNavigation();
  const onOpenLocalFileLink = timelineNavigation?.onOpenLocalFileLink;
  const workspaceRootPath = timelineNavigation?.workspaceRootPath;
  const navigation = useAppNavigationHost();
  const onOpenLink = useCallback<MarkdownPreviewLinkHandler>(
    ({ href }) => navigation.openUrl({ url: href }),
    [navigation],
  );
  const linkRouting = useMemo<MarkdownLinkRouting>(() => {
    if (onOpenLocalFileLink === undefined) {
      return { onOpenLink };
    }
    const localFile: MarkdownLocalFileLinkRouting = {
      absoluteLinks: { kind: "trusted-host" },
      onOpenLink: onOpenLocalFileLink,
    };
    if (workspaceRootPath !== undefined) {
      localFile.relativeLinks = {
        baseDir: workspaceRootPath,
        rootPath: workspaceRootPath,
      };
    }
    return { localFile, onOpenLink };
  }, [onOpenLink, onOpenLocalFileLink, workspaceRootPath]);

  return (
    <MarkdownPreview
      content={content}
      className={className}
      linkRouting={linkRouting}
    />
  );
}
