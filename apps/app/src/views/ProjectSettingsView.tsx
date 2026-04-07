import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Github, Monitor, MoreHorizontal } from "lucide-react";
import { isLocalPathProjectSource, type ProjectSource } from "@bb/domain";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageShell } from "@/components/layout/PageShell";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useProjects } from "@/hooks/queries/project-queries";
import { projectsQueryKey } from "@/hooks/queries/query-keys";
import { useHosts } from "@/hooks/queries/system-queries";
import * as api from "@/lib/api";

function sourceLabel(source: ProjectSource, hostNameById: Map<string, string>): string {
  if (isLocalPathProjectSource(source)) {
    return hostNameById.get(source.hostId) ?? source.hostId;
  }
  return source.repoUrl;
}

export function ProjectSettingsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects, isLoading } = useProjects();
  const { data: hosts = [] } = useHosts();
  const queryClient = useQueryClient();

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const deleteSource = useMutation({
    mutationFn: ({ sourceId }: { sourceId: string }) =>
      api.removeProjectSource(projectId!, sourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
      setDeleteTarget(null);
    },
  });

  const project = projects?.find((p) => p.id === projectId);
  const sources = project?.sources ?? [];
  const hostNameById = new Map(hosts.map((h) => [h.id, h.name]));

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <SettingsSection title="Project Sources">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sources configured.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0"
                >
                  {isLocalPathProjectSource(source) ? (
                    <Monitor className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Github className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {isLocalPathProjectSource(source) ? (
                      <>
                        {source.path}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {hostNameById.get(source.hostId) ?? source.hostId}
                        </span>
                      </>
                    ) : (
                      source.repoUrl
                    )}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        aria-label="Source actions"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        disabled={sources.length <= 1}
                        onSelect={() =>
                          setDeleteTarget({
                            id: source.id,
                            label: sourceLabel(source, hostNameById),
                          })
                        }
                      >
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove source?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `Remove "${deleteTarget.label}" from this project? This cannot be undone.`
                : "Remove this source? This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              disabled={!deleteTarget || deleteSource.isPending}
              onClick={() => {
                if (!deleteTarget) return;
                deleteSource.mutate({ sourceId: deleteTarget.id });
              }}
            >
              Remove source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
