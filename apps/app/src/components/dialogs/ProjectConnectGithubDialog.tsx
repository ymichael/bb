import type { GithubRepoInfo } from "@bb/server-contract";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Icon } from "@/components/ui/icon.js";
import { Input } from "@/components/ui/input.js";

interface ProjectConnectGithubDialogProps {
  open: boolean;
  search: string;
  repos: readonly GithubRepoInfo[];
  isLoading: boolean;
  isFetching: boolean;
  isAddPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSearchChange: (search: string) => void;
  onSelectRepo: (repoUrl: string) => void;
}

export function ProjectConnectGithubDialog({
  open,
  onOpenChange,
  ...rest
}: ProjectConnectGithubDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ProjectConnectGithubDialogContent {...rest} />
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectConnectGithubDialogContentProps {
  search: string;
  repos: readonly GithubRepoInfo[];
  isLoading: boolean;
  isFetching: boolean;
  isAddPending: boolean;
  onSearchChange: (search: string) => void;
  onSelectRepo: (repoUrl: string) => void;
}

export function ProjectConnectGithubDialogContent({
  search,
  repos,
  isLoading,
  isFetching,
  isAddPending,
  onSearchChange,
  onSelectRepo,
}: ProjectConnectGithubDialogContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect GitHub repository</DialogTitle>
        <DialogDescription>
          Select a repository to connect to this project.
        </DialogDescription>
      </DialogHeader>
      <div className="relative">
        <Input
          placeholder="Search repositories…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {isFetching && !isLoading ? (
          <Icon name="Spinner" className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      <div className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Icon name="Spinner" className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : repos.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {search ? "No matching repositories" : "No repositories found"}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {repos.map((repo) => (
              <button
                key={repo.fullName}
                type="button"
                className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-state-hover disabled:opacity-50"
                disabled={isAddPending}
                onClick={() => onSelectRepo(repo.htmlUrl)}
              >
                <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                {repo.private ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Private
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
