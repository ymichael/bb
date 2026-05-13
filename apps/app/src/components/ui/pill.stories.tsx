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

const VARIANT_CONTENT: Record<PillVariant, string> = {
  default: "v1.2",
  secondary: "managed",
  destructive: "Failed",
  outline: "manager",
  emphasis: "active",
};

export function Overview() {
  return (
    <>
      <StoryCard>
        {variants.map((variant) => (
          <StoryRow key={variant} label={variant}>
            <Pill variant={variant}>{VARIANT_CONTENT[variant]}</Pill>
          </StoryRow>
        ))}
      </StoryCard>
      <StoryCard>
        <StoryRow label="standard">
          <Pill variant="outline">feat/review-flow</Pill>
        </StoryRow>
        <StoryRow label="truncated" hint="max-w-40">
          <Pill variant="outline" className="max-w-40">
            feat/very-long-branch-name-that-truncates
          </Pill>
        </StoryRow>
      </StoryCard>
    </>
  );
}
