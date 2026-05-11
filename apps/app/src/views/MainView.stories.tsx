import type { ReactNode } from "react";
import { MainViewBody } from "./MainView";
import { StoryCard, StoryRow } from "../../.ladle/story-card";

export default {
  title: "views/Main View",
};

const noop = () => {};

// MainView's body renders inside `<main>` which is a flex column with padding
// (see AppLayout). PageShell uses negative margins to bleed past that padding,
// so reproduce the same wrapper shape here.
function MainViewStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[260px] w-full min-w-0 flex-col rounded-md border border-border/70 bg-background p-4 md:p-5">
      {children}
    </div>
  );
}

export const States = () => (
  <StoryCard className="bg-card">
    <StoryRow
      label="Loading"
      hint="Initial fetch in flight, or errored before the WebSocket has connected (within the 10s grace period). The sidebar already shows skeletons in this case; the main pane mirrors it so the cold-start race doesn't flash misleading content. After the grace period the state flips to 'Couldn't load projects' below."
    >
      <MainViewStage>
        <MainViewBody
          status="loading"
          isCreating={false}
          isAvailable={false}
          onCreate={noop}
          onRetry={noop}
        />
      </MainViewStage>
    </StoryRow>

    <StoryRow
      label="Couldn't load projects"
      hint="Projects API errored and either the WebSocket is connected or the 10s grace period has elapsed — i.e. we've given up assuming the cold-start race will resolve itself. Steady-state failure surfaces a retry action instead of an infinite spinner."
    >
      <MainViewStage>
        <MainViewBody
          status="unavailable"
          isCreating={false}
          isAvailable={true}
          onCreate={noop}
          onRetry={noop}
        />
      </MainViewStage>
    </StoryRow>

    <StoryRow
      label="No local daemon"
      hint="Steady state with no daemon reachable (mobile browser, daemon crashed, deployed instance with no local daemon). Was previously a disabled button that pretended to be a CTA — now a plain explanation with no action."
    >
      <MainViewStage>
        <MainViewBody
          status="ready"
          isCreating={false}
          isAvailable={false}
          onCreate={noop}
          onRetry={noop}
        />
      </MainViewStage>
    </StoryRow>

    <StoryRow
      label="Create a project"
      hint="Happy path for a fresh local install: server up, daemon up, no projects yet."
    >
      <MainViewStage>
        <MainViewBody
          status="ready"
          isCreating={false}
          isAvailable={true}
          onCreate={noop}
          onRetry={noop}
        />
      </MainViewStage>
    </StoryRow>

    <StoryRow
      label="Creating"
      hint="Create dialog submitted, waiting for the server to respond."
    >
      <MainViewStage>
        <MainViewBody
          status="ready"
          isCreating={true}
          isAvailable={true}
          onCreate={noop}
          onRetry={noop}
        />
      </MainViewStage>
    </StoryRow>
  </StoryCard>
);
