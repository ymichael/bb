import { Navigate } from "react-router-dom";
import { useProjects } from "../hooks/useApi";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/layout/PageShell";
import { useQuickCreateProject } from "@/hooks/useQuickCreateProject";

export function MainView() {
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { createFromPicker, isCreating } = useQuickCreateProject();
  const hasProjects = (projects?.length ?? 0) > 0;

  if (projectsLoading) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading projects...</p>
      </PageShell>
    );
  }

  if (!hasProjects) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-muted-foreground">
            Create a new project to get started
          </p>
          <Button
            onClick={() => {
              void createFromPicker();
            }}
            disabled={isCreating}
          >
            {isCreating ? "Creating..." : "New project"}
          </Button>
        </div>
      </PageShell>
    );
  }

  return <Navigate to={`/projects/${projects![0].id}`} replace />;
}
