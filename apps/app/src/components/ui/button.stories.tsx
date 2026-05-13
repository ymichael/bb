import { Button, type ButtonProps } from "./button";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { Icon } from "@/components/ui";

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

const VARIANT_LABEL: Record<ButtonVariant, string> = {
  default: "Save changes",
  secondary: "Cancel",
  outline: "Connect repo",
  ghost: "Settings",
  destructive: "Delete project",
  link: "View docs",
};

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
                aria-label={size === "icon" ? VARIANT_LABEL[variant] : undefined}
              >
                {size === "icon" ? <Icon name="Plus" /> : VARIANT_LABEL[variant]}
              </Button>
            ))}
          </StoryRow>
        ))}
      </StoryCard>
      <StoryCard>
        <StoryRow label="with icons">
          <Button>
            <Icon name="Check" />
            Save changes
          </Button>
          <Button variant="outline" size="sm">
            Connect GitHub repo
            <Icon name="ArrowRight" />
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
