import { Navigate } from "react-router-dom";
import { useProjects } from "../hooks/queries/project-queries";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/layout/PageShell";

export function MainView() {
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const quickCreateProject = useQuickCreateProjectController();
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
              quickCreateProject.openCreateDialog();
            }}
            disabled={quickCreateProject.isCreating || !quickCreateProject.isAvailable}
          >
            {quickCreateProject.isCreating
              ? "Creating..."
              : !quickCreateProject.isAvailable
                ? "No local daemon"
                : "New project"}
          </Button>
        </div>
      </PageShell>
    );
  }

  return <Navigate to={`/projects/${projects![0].id}`} replace />;
}
