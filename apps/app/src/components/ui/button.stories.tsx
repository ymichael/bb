import { Archive, Check, Plus, Trash2 } from "lucide-react";
import { Button, type ButtonProps } from "./button";

export default {
  title: "Primitives/Button",
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

export function Variants() {
  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        {variants.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant === "destructive" ? <Trash2 /> : <Check />}
            {variant}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {sizes.map((size) => (
          <Button
            key={size}
            size={size}
            aria-label={size === "icon" ? "Add item" : undefined}
          >
            {size === "icon" ? <Plus /> : <Archive />}
            {size === "icon" ? null : size}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled>Disabled</Button>
        <Button variant="outline" disabled>
          Disabled outline
        </Button>
      </div>
    </div>
  );
}
