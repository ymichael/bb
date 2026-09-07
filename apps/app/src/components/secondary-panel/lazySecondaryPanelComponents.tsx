import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { Panel } from "react-resizable-panels";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import { PANEL_COLLAPSE_TRANSITION_CLASS } from "./panelTransitionTokens";
import {
  CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT,
} from "./secondaryPanelSizing";
import { secondaryPanelWidthPercentAtom } from "./threadSecondaryPanelAtoms";

type ThreadSecondaryPanelModule = typeof import("./ThreadSecondaryPanel");
type ThreadSecondaryPanelTabContentModule =
  typeof import("./ThreadSecondaryPanelTabContent");
type ThreadTerminalPanelModule =
  typeof import("@/components/thread/terminal/ThreadTerminalPanel");
type BrowserTabDeckModule = typeof import("./BrowserTabDeck");
type NewTabPageModule = typeof import("./NewTabPage");
type FilePreviewModule = typeof import("./FilePreview");
type ThreadStorageFileTreeModule = typeof import("./ThreadStorageFileTree");

let threadSecondaryPanelModulePromise: Promise<ThreadSecondaryPanelModule> | null =
  null;

function loadThreadSecondaryPanel(): Promise<ThreadSecondaryPanelModule> {
  threadSecondaryPanelModulePromise ??= import("./ThreadSecondaryPanel");
  return threadSecondaryPanelModulePromise;
}

export function preloadThreadSecondaryPanel(): void {
  void loadThreadSecondaryPanel().catch(() => {
    threadSecondaryPanelModulePromise = null;
  });
}

const ThreadSecondaryPanelChunk = lazy(() =>
  loadThreadSecondaryPanel().then(({ ThreadSecondaryPanel }) => ({
    default: ThreadSecondaryPanel,
  })),
);
const ThreadTerminalPanelChunk = lazy(() =>
  import("@/components/thread/terminal/ThreadTerminalPanel").then(
    ({ ThreadTerminalPanel }) => ({ default: ThreadTerminalPanel }),
  ),
);
const BrowserTabDeckChunk = lazy(() =>
  import("./BrowserTabDeck").then(({ BrowserTabDeck }) => ({
    default: BrowserTabDeck,
  })),
);
const NewTabPageChunk = lazy(() =>
  import("./NewTabPage").then(({ NewTabPage }) => ({ default: NewTabPage })),
);
const FilePreviewChunk = lazy(() =>
  import("./FilePreview").then(({ FilePreview }) => ({
    default: FilePreview,
  })),
);
const ThreadStorageFileTreeChunk = lazy(() =>
  import("./ThreadStorageFileTree").then(({ ThreadStorageFileTree }) => ({
    default: ThreadStorageFileTree,
  })),
);
const WorkspaceFilePreviewTabContentChunk = lazy(() =>
  import("./ThreadSecondaryPanelTabContent").then(
    ({ WorkspaceFilePreviewTabContent }) => ({
      default: WorkspaceFilePreviewTabContent,
    }),
  ),
);
const HostFilePreviewTabContentChunk = lazy(() =>
  import("./ThreadSecondaryPanelTabContent").then(
    ({ HostFilePreviewTabContent }) => ({
      default: HostFilePreviewTabContent,
    }),
  ),
);
const HostScopedFilePreviewTabContentChunk = lazy(() =>
  import("./ThreadSecondaryPanelTabContent").then(
    ({ HostScopedFilePreviewTabContent }) => ({
      default: HostScopedFilePreviewTabContent,
    }),
  ),
);
const ProjectFilePreviewTabContentChunk = lazy(() =>
  import("./ThreadSecondaryPanelTabContent").then(
    ({ ProjectFilePreviewTabContent }) => ({
      default: ProjectFilePreviewTabContent,
    }),
  ),
);
const ThreadStorageFilePreviewTabContentChunk = lazy(() =>
  import("./ThreadSecondaryPanelTabContent").then(
    ({ ThreadStorageFilePreviewTabContent }) => ({
      default: ThreadStorageFilePreviewTabContent,
    }),
  ),
);

export function SecondaryPanelContentSkeleton() {
  return (
    <div
      className="space-y-2 px-4 py-4"
      data-testid="secondary-panel-content-skeleton"
    >
      <Skeleton className="h-3 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-5/6 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
    </div>
  );
}

interface ThreadSecondaryPanelInlinePlaceholderProps {
  isOpen: boolean;
  isConversationCollapsed: boolean;
  resizablePanelId: string | undefined;
}

function ThreadSecondaryPanelInlinePlaceholder({
  isOpen,
  isConversationCollapsed,
  resizablePanelId,
}: ThreadSecondaryPanelInlinePlaceholderProps) {
  const persistedWidthPercent = useAtomValue(secondaryPanelWidthPercentAtom);
  return (
    <Panel
      id={resizablePanelId}
      collapsible
      collapsedSize={0}
      defaultSize={
        isOpen
          ? isConversationCollapsed
            ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
            : persistedWidthPercent
          : 0
      }
      minSize={THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT}
      maxSize={
        isConversationCollapsed
          ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
          : THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT
      }
      order={2}
      className={cn(
        "min-w-0 overflow-clip",
        `relative transition-[flex-grow,flex-basis] ${PANEL_COLLAPSE_TRANSITION_CLASS}`,
        isOpen && !isConversationCollapsed && "border-l border-border-seam",
      )}
      data-testid="thread-secondary-panel-placeholder"
    >
      {isOpen ? (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background pt-12">
          <SecondaryPanelContentSkeleton />
        </div>
      ) : null}
    </Panel>
  );
}

type LazyThreadSecondaryPanelProps = ComponentProps<
  ThreadSecondaryPanelModule["ThreadSecondaryPanel"]
> & {
  drawerFallback: ReactNode;
};

export function LazyThreadSecondaryPanel({
  drawerFallback,
  ...props
}: LazyThreadSecondaryPanelProps) {
  const fallback = props.renderAsDrawer ? (
    drawerFallback
  ) : (
    <ThreadSecondaryPanelInlinePlaceholder
      isOpen={props.isOpen}
      isConversationCollapsed={props.isConversationCollapsed}
      resizablePanelId={props.resizablePanelId}
    />
  );
  return (
    <Suspense fallback={fallback}>
      <ThreadSecondaryPanelChunk {...props} />
    </Suspense>
  );
}

export function LazyThreadTerminalPanel(
  props: ComponentProps<ThreadTerminalPanelModule["ThreadTerminalPanel"]>,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <ThreadTerminalPanelChunk {...props} />
    </Suspense>
  );
}

export function LazyBrowserTabDeck(
  props: ComponentProps<BrowserTabDeckModule["BrowserTabDeck"]>,
) {
  return (
    <Suspense fallback={null}>
      <BrowserTabDeckChunk {...props} />
    </Suspense>
  );
}

export function LazyNewTabPage(
  props: ComponentProps<NewTabPageModule["NewTabPage"]>,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <NewTabPageChunk {...props} />
    </Suspense>
  );
}

export function LazyFilePreview(
  props: ComponentProps<FilePreviewModule["FilePreview"]>,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <FilePreviewChunk {...props} />
    </Suspense>
  );
}

export function LazyThreadStorageFileTree({
  fallback,
  ...props
}: ComponentProps<ThreadStorageFileTreeModule["ThreadStorageFileTree"]> & {
  fallback: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <ThreadStorageFileTreeChunk {...props} />
    </Suspense>
  );
}

export function LazyWorkspaceFilePreviewTabContent(
  props: ComponentProps<
    ThreadSecondaryPanelTabContentModule["WorkspaceFilePreviewTabContent"]
  >,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <WorkspaceFilePreviewTabContentChunk {...props} />
    </Suspense>
  );
}

export function LazyHostFilePreviewTabContent(
  props: ComponentProps<
    ThreadSecondaryPanelTabContentModule["HostFilePreviewTabContent"]
  >,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <HostFilePreviewTabContentChunk {...props} />
    </Suspense>
  );
}

export function LazyHostScopedFilePreviewTabContent(
  props: ComponentProps<
    ThreadSecondaryPanelTabContentModule["HostScopedFilePreviewTabContent"]
  >,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <HostScopedFilePreviewTabContentChunk {...props} />
    </Suspense>
  );
}

export function LazyProjectFilePreviewTabContent(
  props: ComponentProps<
    ThreadSecondaryPanelTabContentModule["ProjectFilePreviewTabContent"]
  >,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <ProjectFilePreviewTabContentChunk {...props} />
    </Suspense>
  );
}

export function LazyThreadStorageFilePreviewTabContent(
  props: ComponentProps<
    ThreadSecondaryPanelTabContentModule["ThreadStorageFilePreviewTabContent"]
  >,
) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <ThreadStorageFilePreviewTabContentChunk {...props} />
    </Suspense>
  );
}
