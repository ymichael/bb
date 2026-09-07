import type { ReactNode } from "react";

import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";

export default {
  title: "ui/ScrollToBottomButton",
};

const noop = () => {};

function ButtonStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-28 w-28 cursor-default items-end justify-center rounded-md border border-dashed border-border bg-surface-recessed">
      {children}
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard labelWidth="180px">
      <StoryRow
        label="idle"
        hint="Scrolled up; hover the arrow to verify the pointer cursor."
      >
        <ButtonStage>
          <ScrollToBottomButton visible active={false} onClick={noop} />
        </ButtonStage>
      </StoryRow>
      <StoryRow
        label="active"
        hint="Agent running; the arrow keeps the same hover target."
      >
        <ButtonStage>
          <ScrollToBottomButton visible active onClick={noop} />
        </ButtonStage>
      </StoryRow>
      <StoryRow
        label="hidden"
        hint="At bottom; the control ignores pointer events."
      >
        <ButtonStage>
          <ScrollToBottomButton visible={false} active onClick={noop} />
        </ButtonStage>
      </StoryRow>
    </StoryCard>
  );
}

function MockTimelineFrame({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex h-80 w-72 flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex-1 space-y-3 overflow-hidden p-3">
          <div className="ml-auto w-3/5 rounded-md bg-surface-recessed p-2 text-sm text-foreground">
            Can you summarize the diff?
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-11/12 rounded bg-muted" />
            <div className="h-3 w-full rounded bg-muted" />
            <div className="h-3 w-4/5 rounded bg-muted" />
          </div>
          <div className="ml-auto w-1/2 rounded-md bg-surface-recessed p-2 text-sm text-foreground">
            And the tests?
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-3/4 rounded bg-muted" />
            <div className="h-3 w-5/6 rounded bg-muted" />
          </div>
        </div>
        <ScrollToBottomButton visible active={active} onClick={noop} />
        <div className="border-t border-border p-2">
          <div className="h-9 rounded-md border border-border bg-surface-recessed" />
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function InThread() {
  return (
    <div className="flex gap-10 p-8">
      <MockTimelineFrame active={false} label="Idle — scrolled up" />
      <MockTimelineFrame active label="Active — agent working" />
    </div>
  );
}
