import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PageShell } from "@/components/layout/PageShell";
import { useProjects, useUpdateProject } from "@/hooks/useApi";

export function ProjectSettingsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects } = useProjects();
  const updateProject = useUpdateProject();
  const project = projects?.find((item) => item.id === projectId);
  const [projectInstructions, setProjectInstructions] = useState("");

  useEffect(() => {
    setProjectInstructions(project?.projectInstructions ?? "");
  }, [project?.projectInstructions]);

  if (!projectId || !project) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">Project not found</p>
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="mx-auto w-full max-w-2xl space-y-3">
        <h2 className="text-sm font-semibold">Project settings</h2>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Project instructions
          </label>
          <textarea
            value={projectInstructions}
            onChange={(event) => setProjectInstructions(event.target.value)}
            rows={8}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus-visible:ring-2"
            placeholder="Example: Run tests before committing. Commit at the end of each task."
          />
          <div className="flex justify-end">
            <button
              type="button"
              className="text-xs underline underline-offset-2"
              onClick={() => {
                updateProject.mutate({
                  id: projectId,
                  projectInstructions,
                });
              }}
              disabled={updateProject.isPending}
            >
              {updateProject.isPending ? "Saving..." : "Save settings"}
            </button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
