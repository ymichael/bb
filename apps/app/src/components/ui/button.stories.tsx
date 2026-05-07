import { ArrowRight, Check, Plus } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Button",
};

type ButtonVariant = NonNullable<ButtonProps["variant"]>;
type ButtonSize = NonNullable<ButtonProps["size"]>;

const variants: readonly ButtonVariant[] = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
];

const sizes: readonly ButtonSize[] = ["sm", "default", "lg", "icon"];

export function Overview() {
  return (
    <>
      <StoryCard columns={sizes}>
        {variants.map((variant) => (
          <StoryRow key={variant} label={variant}>
            {sizes.map((size) => (
              <Button
                key={size}
                variant={variant}
                size={size}
                aria-label={size === "icon" ? "Add" : undefined}
              >
                {size === "icon" ? <Plus /> : size}
              </Button>
            ))}
          </StoryRow>
        ))}
      </StoryCard>
      <StoryCard>
        <StoryRow label="with icons">
          <Button>
            <Check />
            Save
          </Button>
          <Button>
            Open
            <ArrowRight />
          </Button>
          <Button>
            <Check />
            Save
            <ArrowRight />
          </Button>
        </StoryRow>
        <StoryRow label="disabled">
          {variants.map((variant) => (
            <Button key={variant} variant={variant} disabled>
              {variant}
            </Button>
          ))}
        </StoryRow>
      </StoryCard>
    </>
  );
}
