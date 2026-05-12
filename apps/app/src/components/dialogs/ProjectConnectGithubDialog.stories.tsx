import type { GithubRepoInfo } from "@bb/server-contract";
import { ProjectConnectGithubDialogContent } from "./ProjectConnectGithubDialog";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Project Connect GitHub",
};

const noop = () => {};

function makeRepo(overrides: Partial<GithubRepoInfo> = {}): GithubRepoInfo {
  return {
    fullName: "anthropics/bb",
    htmlUrl: "https://github.com/anthropics/bb",
    defaultBranch: "main",
    private: false,
    ...overrides,
  };
}

const repos: readonly GithubRepoInfo[] = [
  makeRepo({ fullName: "anthropics/bb", htmlUrl: "https://github.com/anthropics/bb" }),
  makeRepo({
    fullName: "anthropics/claude-code",
    htmlUrl: "https://github.com/anthropics/claude-code",
    private: true,
  }),
  makeRepo({
    fullName: "anthropics/internal-tooling-ingest-pipeline",
    htmlUrl: "https://github.com/anthropics/internal-tooling-ingest-pipeline",
    private: true,
  }),
  makeRepo({ fullName: "vercel/next.js", htmlUrl: "https://github.com/vercel/next.js" }),
  makeRepo({ fullName: "facebook/react", htmlUrl: "https://github.com/facebook/react" }),
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="default"
        hint="repo list with mix of public + private; first row is focused on hover"
      >
        <DialogStage>
          <ProjectConnectGithubDialogContent
            search=""
            repos={repos}
            isLoading={false}
            isFetching={false}
            isAddPending={false}
            onSearchChange={noop}
            onSelectRepo={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="searching"
        hint="user is typing; spinner appears at the right edge of the input"
      >
        <DialogStage>
          <ProjectConnectGithubDialogContent
            search="anthropics"
            repos={repos.slice(0, 3)}
            isLoading={false}
            isFetching
            isAddPending={false}
            onSearchChange={noop}
            onSelectRepo={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="loading"
        hint="initial fetch — full-area spinner replaces the list"
      >
        <DialogStage>
          <ProjectConnectGithubDialogContent
            search=""
            repos={[]}
            isLoading
            isFetching={false}
            isAddPending={false}
            onSearchChange={noop}
            onSelectRepo={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="no results"
        hint="search matched nothing — empty-state message reflects the search"
      >
        <DialogStage>
          <ProjectConnectGithubDialogContent
            search="zzzz"
            repos={[]}
            isLoading={false}
            isFetching={false}
            isAddPending={false}
            onSearchChange={noop}
            onSelectRepo={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="empty"
        hint="account has no accessible repos — generic empty copy"
      >
        <DialogStage>
          <ProjectConnectGithubDialogContent
            search=""
            repos={[]}
            isLoading={false}
            isFetching={false}
            isAddPending={false}
            onSearchChange={noop}
            onSelectRepo={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="add in flight"
        hint="user clicked a repo; all rows disabled until the mutation resolves"
      >
        <DialogStage>
          <ProjectConnectGithubDialogContent
            search=""
            repos={repos}
            isLoading={false}
            isFetching={false}
            isAddPending
            onSearchChange={noop}
            onSelectRepo={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
