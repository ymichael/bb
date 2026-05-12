import { Fragment, type CSSProperties, type Ref, type ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Archive, ChevronRight, Settings } from "lucide-react";
import type { Thread } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { AppPageHeader, HEADER_ICON_BUTTON_CLASS } from "./AppPageHeader";
import { HIRE_PROJECT_MANAGER_MUTATION_KEY } from "@/hooks/mutations/project-mutations";
import { useProjects } from "@/hooks/queries/project-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import { useAppRoute } from "@/hooks/useAppRoute";
import { useDialogState } from "@/hooks/useDialogState";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { HireManagerDialog } from "@/components/dialogs/HireManagerDialog";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { ProjectActionsMenu } from "@/components/project/ProjectActionsMenu";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";

const SIDEBAR_WIDTH_KEY = "bb.sidebar.width";
const SIDEBAR_OPEN_KEY = "bb.sidebar.open";
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_DEFAULT_WIDTH = 320;

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

const sidebarWidthStorage = createLocalStorageSyncStorage<number>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) {
      return initialValue;
    }
    const parsedValue = Number(storedValue);
    if (!Number.isFinite(parsedValue)) {
      return initialValue;
    }
    return clampSidebarWidth(parsedValue);
  },
  serialize: (value) => String(clampSidebarWidth(value)),
});
const sidebarWidthAtom = atomWithStorage<number>(
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  sidebarWidthStorage,
  { getOnInit: true },
);

// Held in jotai (rather than as `useState` inside AppLayout) so that toggling
// the sidebar does not re-render AppLayout — only the small bridge below
// subscribes. AppLayout's `children` reference stays stable across toggles,
// so React's element-reference bailout skips re-rendering the entire route
// subtree (ThreadDetailView, the timeline, etc.).
const sidebarOpenStorage = createLocalStorageSyncStorage<boolean>({
  parse: (storedValue, initialValue) => {
    if (storedValue === "true") return true;
    if (storedValue === "false") return false;
    return initialValue;
  },
  serialize: (value) => String(value),
});
const sidebarOpenAtom = atomWithStorage<boolean>(
  SIDEBAR_OPEN_KEY,
  true,
  sidebarOpenStorage,
  { getOnInit: true },
);

interface SidebarStateBridgeProps {
  providerRef: Ref<HTMLDivElement>;
  style: CSSProperties;
  children: ReactNode;
}

function SidebarStateBridge({
  providerRef,
  style,
  children,
}: SidebarStateBridgeProps) {
  const [open, setOpen] = useAtom(sidebarOpenAtom);
  return (
    <SidebarProvider
      ref={providerRef}
      style={style}
      open={open}
      onOpenChange={setOpen}
    >
      {children}
    </SidebarProvider>
  );
}

const routeTitles: Record<string, { title: string; subtitle?: string }> = {
  "/": { title: "Projects", subtitle: "Select or create a project" },
  "/settings": { title: "Settings" },
  "/development-only/replay": { title: "Replay threads" },
};

interface AppHeaderProps {
  isProjectMainView: boolean;
  projectId?: string;
  project?: ProjectResponse;
  meta: {
    title: string;
    subtitle?: string;
    breadcrumbs?: Array<{ label: string; to?: string }>;
  };
}

function AppHeader({
  isProjectMainView,
  projectId,
  project,
  meta,
}: AppHeaderProps) {
  const showProjectMenuButton = isProjectMainView && !!project;
  const showProjectNameInHeader = !isProjectMainView;
  const headerBreadcrumbs = showProjectNameInHeader
    ? meta.breadcrumbs
    : undefined;
  const headerTitle = headerBreadcrumbs
    ? undefined
    : showProjectNameInHeader
      ? meta.title
      : undefined;

  const hasCenterContent =
    Boolean(headerBreadcrumbs) ||
    Boolean(headerTitle) ||
    Boolean(meta.subtitle);

  const center = hasCenterContent ? (
    <div className="min-w-0 flex-1">
      {headerBreadcrumbs ? (
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {headerBreadcrumbs.map((segment, index) => {
            const isLast = index === headerBreadcrumbs.length - 1;
            return (
              <Fragment key={`${segment.label}-${index}`}>
                {index > 0 ? (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
                ) : null}
                {!isLast && segment.to ? (
                  <Link
                    to={segment.to}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {segment.label}
                  </Link>
                ) : (
                  <span
                    className={
                      isLast
                        ? "min-w-0 truncate"
                        : "shrink-0 text-muted-foreground"
                    }
                  >
                    {segment.label}
                  </span>
                )}
              </Fragment>
            );
          })}
        </p>
      ) : null}
      {headerTitle ? (
        <p className="truncate text-sm font-semibold">{headerTitle}</p>
      ) : null}
      {meta.subtitle ? (
        <p className="truncate text-xs text-muted-foreground">
          {meta.subtitle}
        </p>
      ) : null}
    </div>
  ) : null;

  const actions =
    isProjectMainView && projectId ? (
      <>
        <Link
          to={`/projects/${projectId}/settings`}
          className={cn(
            HEADER_ICON_BUTTON_CLASS,
            "inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
          )}
          aria-label="Project settings"
          title="Project settings"
        >
          <Settings />
        </Link>
        <Link
          to={`/projects/${projectId}/archived`}
          className={cn(
            HEADER_ICON_BUTTON_CLASS,
            "inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
          )}
          aria-label="Archived threads"
          title="Archived threads"
        >
          <Archive />
        </Link>
        {showProjectMenuButton && project ? (
          <ProjectActionsMenu
            project={project}
            triggerClassName={HEADER_ICON_BUTTON_CLASS}
          />
        ) : null}
      </>
    ) : null;

  return (
    <AppPageHeader
      bordered={!isProjectMainView}
      center={center}
      actions={actions}
    />
  );
}

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const quickCreateProject = useQuickCreateProjectController();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const activeHireManagerRequests = useIsMutating({
    mutationKey: HIRE_PROJECT_MANAGER_MUTATION_KEY,
  });
  const hireManagerDialog = useDialogState<string>();
  const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtom);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const liveWidthRef = useRef(sidebarWidth);
  const animationFrameRef = useRef<number | null>(null);

  const {
    projectId,
    threadId,
    isProjectMainView,
    isThreadView,
    isArchivedView,
    isSettingsView,
    isRootView,
  } = useAppRoute();
  const showHeader = !isRootView && !isThreadView;
  const showFloatingSidebarTrigger = isRootView;

  const project = projectId
    ? projects?.find((candidate) => candidate.id === projectId)
    : undefined;
  const projectName = projectId ? project?.name : undefined;
  const projectLabel =
    projectName ??
    (projectId
      ? projectsLoading
        ? "Loading project…"
        : projectId
      : undefined);
  const { data: thread } = useThread(threadId ?? "");
  const threadDisplayTitle = thread
    ? getThreadDisplayTitle(thread)
    : threadId
      ? `Thread ${threadId.slice(0, 8)}`
      : "Thread";
  const meta = isThreadView
    ? {
        title: thread ? getThreadDisplayTitle(thread) : "Thread",
        subtitle: undefined,
      }
    : isArchivedView && projectId
      ? {
          title: "",
          subtitle: undefined,
          breadcrumbs: [
            {
              label: projectLabel ?? projectId,
              to: `/projects/${projectId}`,
            },
            { label: "Archived" },
          ],
        }
      : isSettingsView && projectId
        ? {
            title: "",
            subtitle: undefined,
            breadcrumbs: [
              {
                label: projectLabel ?? projectId,
                to: `/projects/${projectId}`,
              },
              { label: "Settings" },
            ],
          }
        : projectId
          ? {
              title: projectLabel ?? projectId,
              subtitle: undefined,
            }
          : (routeTitles[location.pathname] ?? { title: "" });

  const documentTitle = (() => {
    if (isThreadView) {
      return threadDisplayTitle;
    }
    if (isArchivedView && projectId) {
      return `${projectLabel ?? projectId} · Archived`;
    }
    if (isSettingsView && projectId) {
      return `${projectLabel ?? projectId} · Settings`;
    }
    if (projectId) {
      return projectLabel ?? projectId;
    }
    const routeTitle = routeTitles[location.pathname]?.title;
    return routeTitle && routeTitle.length > 0 ? routeTitle : "BB";
  })();

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsSidebarResizing(true);
      startXRef.current = event.clientX;
      startWidthRef.current = liveWidthRef.current;
      document.body.classList.add("sidebar-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  useEffect(() => {
    if (!isSidebarResizing) return;

    const applyLiveWidth = () => {
      animationFrameRef.current = null;
      providerRef.current?.style.setProperty(
        "--sidebar-width",
        `${liveWidthRef.current}px`,
      );
    };

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startXRef.current;
      liveWidthRef.current = clampSidebarWidth(startWidthRef.current + delta);
      if (animationFrameRef.current === null) {
        animationFrameRef.current =
          window.requestAnimationFrame(applyLiveWidth);
      }
    };

    const handleMouseUp = () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      providerRef.current?.style.setProperty(
        "--sidebar-width",
        `${liveWidthRef.current}px`,
      );
      setSidebarWidth(liveWidthRef.current);
      setIsSidebarResizing(false);
      document.body.classList.remove("sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      document.body.classList.remove("sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isSidebarResizing, setSidebarWidth]);

  useEffect(() => {
    liveWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = documentTitle;
  }, [documentTitle]);
  const isManagerActionPending =
    activeHireManagerRequests > 0 || hireManagerDialog.isOpen;

  return (
    <ProjectActionsProvider>
      <ThreadActionsProvider>
        <SidebarStateBridge
          providerRef={providerRef}
          style={
            {
              "--sidebar-width": `${sidebarWidth}px`,
            } as CSSProperties
          }
        >
          <AppSidebar
            onResizeMouseDown={handleResizeMouseDown}
            isResizing={isSidebarResizing}
            selectedProjectId={projectId}
            isManagerActionPending={isManagerActionPending}
            onNewManager={(targetProjectId) => {
              if (isManagerActionPending) return;
              hireManagerDialog.onOpen(targetProjectId);
            }}
          />
          <SidebarInset>
            <div className="relative flex h-[100dvh] min-w-0 w-full flex-col">
              {showFloatingSidebarTrigger ? (
                <div className="absolute left-3 top-3.5 z-20">
                  <SidebarTrigger className="h-5 w-5 rounded-md p-0" />
                </div>
              ) : null}
              {showHeader ? (
                <AppHeader
                  isProjectMainView={isProjectMainView}
                  projectId={projectId}
                  project={project}
                  meta={meta}
                />
              ) : null}
              <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
                {children}
              </main>
            </div>
          </SidebarInset>
        </SidebarStateBridge>
        <ProjectPathDialog
          target={quickCreateProject.projectPathDialog.target}
          pending={quickCreateProject.isCreating}
          platform={quickCreateProject.platform}
          onOpenChange={quickCreateProject.projectPathDialog.onOpenChange}
          onSubmit={quickCreateProject.submitProjectPath}
        />
        {hireManagerDialog.target ? (
          <HireManagerDialog
            projectId={hireManagerDialog.target}
            open
            onClose={hireManagerDialog.onClose}
            onHired={(thread: Thread) => {
              navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
            }}
          />
        ) : null}
      </ThreadActionsProvider>
    </ProjectActionsProvider>
  );
}
