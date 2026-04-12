import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAtomValue } from "jotai";
import { useDebounceValue } from "usehooks-ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Monitor, MoreHorizontal } from "lucide-react";
import { GitHubIcon } from "@/components/icons/GitHubIcon";
import {
  findLocalPathProjectSourceForHost,
  isGitHubRepoProjectSource,
  isLocalPathProjectSource,
  type ProjectSource,
} from "@bb/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { SettingsRow, SettingsRowList } from "@/components/settings/SettingsRow";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useProjects } from "@/hooks/queries/project-queries";
import { projectsQueryKey } from "@/hooks/queries/query-keys";
import { useGithubRepos, useHosts } from "@/hooks/queries/system-queries";
import { githubConnectedAtom } from "@/lib/atoms";
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
  const { localHostId, pickFolder } = useHostDaemon();
  const githubConnected = useAtomValue(githubConnectedAtom);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");

  const deleteSource = useMutation({
    meta: {
      errorMessage: "Failed to remove source.",
    },
    mutationFn: ({ sourceId }: { sourceId: string }) => {
      if (!projectId) return Promise.resolve();
      return api.removeProjectSource(projectId, sourceId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
      setDeleteTarget(null);
    },
  });

  const addSource = useMutation({
    mutationFn: async () => {
      if (!pickFolder || !localHostId || !projectId) return;
      const selectedPath = await pickFolder();
      if (!selectedPath) return;
      await api.addProjectSource(projectId, {
        type: "local_path",
        hostId: localHostId,
        path: selectedPath,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
    },
  });

  const addGitHubSource = useMutation({
    mutationFn: async (repoUrl: string) => {
      if (!projectId) return;
      await api.addProjectSource(projectId, {
        type: "github_repo",
        repoUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
      setRepoPickerOpen(false);
      setRepoSearch("");
    },
  });

  const [debouncedSearch] = useDebounceValue(repoSearch, 300);
  const { data: githubRepos = [], isLoading: reposLoading, isFetching: reposFetching } = useGithubRepos(repoPickerOpen, debouncedSearch);

  const visibleRepos = useMemo(() => {
    if (!repoSearch) return githubRepos;
    // Don't client-side filter URLs/owner-repo — let the server resolve them
    if (repoSearch.includes("github.com/") || /^[^/\s]+\/[^/\s]+$/.test(repoSearch.trim())) {
      return githubRepos;
    }
    const q = repoSearch.toLowerCase();
    return githubRepos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [githubRepos, repoSearch]);

  const project = projects?.find((p) => p.id === projectId);
  const unsortedSources = project?.sources ?? [];
  const sources = useMemo(
    () => [...unsortedSources].sort((a, b) => {
      const aGh = isGitHubRepoProjectSource(a) ? 0 : 1;
      const bGh = isGitHubRepoProjectSource(b) ? 0 : 1;
      return aGh - bGh;
    }),
    [unsortedSources],
  );
  const hostNameById = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);
  const hasGitHubSource = sources.some(isGitHubRepoProjectSource);

  const canAddLocalSource =
    localHostId != null &&
    pickFolder != null &&
    !findLocalPathProjectSourceForHost(sources, localHostId);
  const canAddGitHubSource = githubConnected && !hasGitHubSource;

  const addSourceButtons = (canAddLocalSource || canAddGitHubSource) ? (
    <div className="mt-2 flex gap-2">
      {canAddGitHubSource && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRepoPickerOpen(true)}
        >
          Connect GitHub repo
        </Button>
      )}
      {canAddLocalSource && (
        <Button
          size="sm"
          variant="outline"
          disabled={addSource.isPending}
          onClick={() => addSource.mutate()}
        >
          Add local path
        </Button>
      )}
    </div>
  ) : null;

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <SettingsSection title="Project Sources">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sources.length === 0 ? (
            <div>
              <p className="text-sm text-muted-foreground">
                No sources configured.
              </p>
              {addSourceButtons}
            </div>
          ) : (
            <div>
              <SettingsRowList>
                {sources.map((source) => (
                  <SettingsRow key={source.id}>
                    {isLocalPathProjectSource(source) ? (
                      <Monitor className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <GitHubIcon className="size-4 shrink-0" />
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
                          className="h-7 w-7 shrink-0 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
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
                  </SettingsRow>
                ))}
              </SettingsRowList>
              {addSourceButtons}
            </div>
          )}
        </SettingsSection>

      </div>

      <Dialog open={repoPickerOpen} onOpenChange={(open) => {
        setRepoPickerOpen(open);
        if (!open) setRepoSearch("");
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect GitHub repository</DialogTitle>
            <DialogDescription>
              Select a repository to connect to this project.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Input
              placeholder="Search repositories…"
              value={repoSearch}
              onChange={(e) => setRepoSearch(e.target.value)}
            />
            {reposFetching && !reposLoading && (
              <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {reposLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : visibleRepos.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {repoSearch ? "No matching repositories" : "No repositories found"}
              </p>
            ) : (
              <div className="divide-y divide-border">
                {visibleRepos.map((repo) => (
                  <button
                    key={repo.fullName}
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                    disabled={addGitHubSource.isPending}
                    onClick={() => addGitHubSource.mutate(repo.htmlUrl)}
                  >
                    <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                    {repo.private && (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 ui-text-xs text-muted-foreground">
                        Private
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

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
