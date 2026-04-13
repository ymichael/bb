import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAtomValue } from "jotai";
import { useDebounceValue } from "usehooks-ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  findLocalPathProjectSourceForHost,
  isGitHubRepoProjectSource,
  isLocalPathProjectSource,
  type LocalPathProjectSource,
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
import { PageShell } from "@/components/layout/PageShell";
import { ProjectPathDialog } from "@/components/project/ProjectPathDialog";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsRowList } from "@/components/settings/SettingsRow";
import { ProjectSourceRow } from "@/views/project-settings/ProjectSourceRow";
import {
  useAddLocalProjectSource,
  useUpdateLocalProjectSource,
} from "@/hooks/mutations/project-mutations";
import {
  isLocalPathMissing,
  useLocalPathExistence,
} from "@/hooks/queries/host-path-queries";
import { useLocalPathPicker, type LocalPathSubmitParams } from "@/hooks/useLocalPathPicker";
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

  const addLocalSource = useAddLocalProjectSource();
  const updateLocalSource = useUpdateLocalProjectSource();

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
  const projectSources = project?.sources;
  const sources = useMemo(
    () => [...(projectSources ?? [])].sort((a, b) => {
      const aGh = isGitHubRepoProjectSource(a) ? 0 : 1;
      const bGh = isGitHubRepoProjectSource(b) ? 0 : 1;
      return aGh - bGh;
    }),
    [projectSources],
  );
  const hostNameById = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);
  const hasGitHubSource = sources.some(isGitHubRepoProjectSource);

  const projectName = project?.name ?? "";
  const localSourcePickerPending =
    addLocalSource.isPending || updateLocalSource.isPending;
  const localSourceSubmit = useCallback(
    ({ path, hostId, target, closeDialog }: LocalPathSubmitParams) => {
      if (!projectId) return;
      if (target.kind === "add-source") {
        addLocalSource.mutate(
          { projectId, path, hostId },
          { onSuccess: closeDialog },
        );
      } else if (target.kind === "update") {
        const source = sources.find(
          (candidate): candidate is LocalPathProjectSource =>
            isLocalPathProjectSource(candidate) && candidate.hostId === hostId,
        );
        if (!source) return;
        updateLocalSource.mutate(
          { projectId, sourceId: source.id, path },
          { onSuccess: closeDialog },
        );
      }
    },
    [addLocalSource, projectId, sources, updateLocalSource],
  );
  const localSourcePicker = useLocalPathPicker({
    isPending: localSourcePickerPending,
    submit: localSourceSubmit,
  });
  const openAddLocalSourcePicker = useCallback(() => {
    if (!projectId) return;
    localSourcePicker.openPicker({
      kind: "add-source",
      projectId,
      projectName,
    });
  }, [localSourcePicker, projectId, projectName]);
  const openEditLocalSourcePicker = useCallback(
    (source: LocalPathProjectSource) => {
      if (!projectId) return;
      localSourcePicker.openPicker({
        kind: "update",
        projectId,
        projectName,
        currentPath: source.path,
      });
    },
    [localSourcePicker, projectId, projectName],
  );
  const localHostId = localSourcePicker.localHostId;

  const localhostSourcePaths = useMemo(() => {
    if (!localHostId) return [] as string[];
    return sources
      .filter((source): source is LocalPathProjectSource =>
        isLocalPathProjectSource(source) && source.hostId === localHostId)
      .map((source) => source.path);
  }, [localHostId, sources]);
  const pathExistence = useLocalPathExistence(localhostSourcePaths);

  const showAddLocalSourceButton =
    localHostId != null && !findLocalPathProjectSourceForHost(sources, localHostId);
  const showAddGitHubSourceButton = githubConnected && !hasGitHubSource;

  const addSourceButtons = (showAddLocalSourceButton || showAddGitHubSourceButton) ? (
    <div className="mt-2 flex gap-2">
      {showAddGitHubSourceButton && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRepoPickerOpen(true)}
        >
          Connect GitHub repo
        </Button>
      )}
      {showAddLocalSourceButton && (
        <Button
          size="sm"
          variant="outline"
          disabled={addLocalSource.isPending}
          onClick={openAddLocalSourcePicker}
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
                {sources.map((source) => {
                  const isLocalhostSource =
                    isLocalPathProjectSource(source) &&
                    localHostId != null &&
                    source.hostId === localHostId;
                  const isInvalid =
                    isLocalhostSource && isLocalPathMissing(pathExistence, source.path);
                  const hostName = isLocalPathProjectSource(source)
                    ? hostNameById.get(source.hostId) ?? source.hostId
                    : "";
                  return (
                    <ProjectSourceRow
                      key={source.id}
                      source={source}
                      isLocalhostSource={isLocalhostSource}
                      isLocalPathInvalid={isInvalid}
                      hostName={hostName}
                      isEditPending={localSourcePickerPending}
                      isOnlySource={sources.length <= 1}
                      onEditLocalPath={openEditLocalSourcePicker}
                      onRemove={(target) =>
                        setDeleteTarget({
                          id: target.id,
                          label: sourceLabel(target, hostNameById),
                        })
                      }
                    />
                  );
                })}
              </SettingsRowList>
              {addSourceButtons}
            </div>
          )}
        </SettingsSection>

      </div>

      <ProjectPathDialog
        target={localSourcePicker.projectPathDialog.target}
        pending={localSourcePickerPending}
        platform={localSourcePicker.platform}
        onOpenChange={localSourcePicker.projectPathDialog.onOpenChange}
        onSubmit={localSourcePicker.submitProjectPath}
      />

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
