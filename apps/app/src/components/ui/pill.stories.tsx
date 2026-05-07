import { Pill, type PillVariant } from "./pill";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Pill",
};

const variants: readonly PillVariant[] = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "emphasis",
];

export function Overview() {
  return (
    <>
      <StoryCard>
        {variants.map((variant) => (
          <StoryRow key={variant} label={variant}>
            <Pill variant={variant}>{variant}</Pill>
          </StoryRow>
        ))}
      </StoryCard>
      <StoryCard>
        <StoryRow label="single character">
          <Pill variant="secondary">A</Pill>
        </StoryRow>
        <StoryRow label="standard">
          <Pill variant="outline">manager-thread</Pill>
        </StoryRow>
        <StoryRow label="truncated" hint="max-w-40">
          <Pill variant="emphasis" className="max-w-40">
            very-long-status-label-that-truncates
          </Pill>
        </StoryRow>
      </StoryCard>
    </>
  );
}
