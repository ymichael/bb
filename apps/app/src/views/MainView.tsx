import { Navigate } from "react-router-dom";
import {
  useProjects,
  useSidebarBootstrap,
} from "../hooks/queries/project-queries";
import {
  useConnectionAwareQueryState,
  type ConnectionAwareQueryStatus,
} from "../hooks/queries/connection-aware-query-state";
import { useActiveProjectId } from "@/hooks/useActiveProjectId";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { Button } from "@/components/ui/button.js";
import { PageShell } from "@/components/ui/page-shell.js";

export interface MainViewBodyProps {
  status: ConnectionAwareQueryStatus;
  isCreating: boolean;
  isAvailable: boolean;
  onCreate: () => void;
  onRetry: () => void;
}

export function MainViewBody({
  status,
  isCreating,
  isAvailable,
  onCreate,
  onRetry,
}: MainViewBodyProps) {
  if (status === "loading") {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading projects...</p>
      </PageShell>
    );
  }

  if (status === "unavailable") {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load projects
          </p>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </PageShell>
    );
  }

  if (!isAvailable) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm font-medium text-foreground">
            No local daemon
          </p>
          <p className="text-xs text-muted-foreground">
            Start a local daemon on this device to create a project.
          </p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="min-h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">
          Create a new project to get started
        </p>
        <Button onClick={onCreate} disabled={isCreating}>
          {isCreating ? "Creating..." : "New project"}
        </Button>
      </div>
    </PageShell>
  );
}

export function MainView() {
  const sidebarBootstrapQuery = useSidebarBootstrap();
  const hasSidebarBootstrapSettled =
    sidebarBootstrapQuery.isSuccess || sidebarBootstrapQuery.isError;
  const projectsQuery = useProjects({ enabled: hasSidebarBootstrapSettled });
  const { data: projects, isLoadingError, refetch } = projectsQuery;
  const projectsState = useConnectionAwareQueryState({
    hasResolvedData: projects !== undefined,
    isFetching: sidebarBootstrapQuery.isFetching || projectsQuery.isFetching,
    isLoadingError,
  });
  const quickCreateProject = useQuickCreateProjectController();
  const activeProjectId = useActiveProjectId();

  if (projectsState.status !== "loading" && activeProjectId) {
    return <Navigate to={`/projects/${activeProjectId}`} replace />;
  }

  return (
    <MainViewBody
      status={projectsState.status}
      isCreating={quickCreateProject.isCreating}
      isAvailable={quickCreateProject.isAvailable}
      onCreate={() => {
        quickCreateProject.openCreateDialog();
      }}
      onRetry={() => {
        void refetch();
      }}
    />
  );
}
