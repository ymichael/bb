import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { OverflowFade, type OverflowFadeTone } from "./overflow-fade";

export default {
  title: "ui/Overflow fade",
};

const TONE_SURFACE_CLASS: Record<OverflowFadeTone, string> = {
  background: "bg-background",
  sidebar: "bg-sidebar",
  "surface-raised": "bg-surface-raised",
};

function FadeStage({
  children,
  tone,
}: {
  children: ReactNode;
  tone: OverflowFadeTone;
}) {
  return (
    <div
      className={`relative h-32 w-[320px] overflow-hidden rounded-md border border-border ${TONE_SURFACE_CLASS[tone]}`}
    >
      <div className="flex flex-col gap-1 p-2">
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="h-6 shrink-0 rounded-sm border border-border-seam"
          />
        ))}
      </div>
      {children}
    </div>
  );
}

export function Sizes() {
  return (
    <StoryCard labelWidth="150px">
      <StoryRow
        label="above — sm"
        hint="h-8, used where a sticky label needs to separate from the rows under it"
      >
        <FadeStage tone="background">
          <OverflowFade placement="above" tone="background" size="sm" />
        </FadeStage>
      </StoryRow>
      <StoryRow label="above — default" hint="h-16, the standard scroll edge">
        <FadeStage tone="background">
          <OverflowFade placement="above" tone="background" />
        </FadeStage>
      </StoryRow>
      <StoryRow
        label="above — lg"
        hint="h-24. Added for the compact home, where rows scroll behind the pinned composer and need to dissolve rather than stop at a hard edge"
      >
        <FadeStage tone="background">
          <OverflowFade placement="above" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow label="below — lg" hint="the same size cast downward">
        <FadeStage tone="background">
          <OverflowFade placement="below" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow
        label="left / right — lg"
        hint="horizontal placements use w-24 at this size"
      >
        <FadeStage tone="background">
          <OverflowFade placement="left" tone="background" size="lg" />
          <OverflowFade placement="right" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Tones() {
  return (
    <StoryCard labelWidth="150px">
      <StoryRow label="background" hint="matches --background surfaces">
        <FadeStage tone="background">
          <OverflowFade placement="above" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow label="sidebar" hint="matches --sidebar surfaces">
        <FadeStage tone="sidebar">
          <OverflowFade placement="above" tone="sidebar" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow label="surface-raised" hint="matches raised panel surfaces">
        <FadeStage tone="surface-raised">
          <OverflowFade placement="above" tone="surface-raised" size="lg" />
        </FadeStage>
      </StoryRow>
    </StoryCard>
  );
}
