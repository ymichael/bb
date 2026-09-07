import { cva, type VariantProps } from "class-variance-authority";
import {
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from "react-native";
import { resolveFont, type FontWeightName } from "@/theme/fonts";
import { cn } from "./cn";

const IS_IOS = process.env.EXPO_OS === "ios";

const SECTION_LABEL_CLASS = IS_IOS
  ? "text-xs text-muted-foreground"
  : "text-xs font-medium uppercase tracking-wide text-subtle-foreground/75";

const textVariants = cva("font-sans text-foreground", {
  variants: {
    variant: {
      body: "text-sm",
      bodyLarge: "text-base",
      title: "text-xl font-bold",
      heading: "text-base font-semibold",
      headline: "text-base font-semibold",
      label: "text-sm font-medium",
      caption: "text-xs text-muted-foreground",
      footnote: "text-xs",
      sectionLabel: SECTION_LABEL_CLASS,
      chrome: "text-2xs text-muted-foreground",
      largeTitle: "text-3xl font-bold",
      mono: "font-mono text-sm",
    },
    tone: {
      default: "",
      foreground: "text-foreground",
      muted: "text-muted-foreground",
      subtle: "text-subtle-foreground",
      readback: "text-readback-foreground",
      primary: "text-primary",
      destructive: "text-destructive-text",
      warning: "text-warning-text",
      success: "text-success",
      inverse: "text-background",
    },
  },
  defaultVariants: {
    variant: "body",
    tone: "default",
  },
});

export type TextVariant = NonNullable<
  VariantProps<typeof textVariants>["variant"]
>;
export type TextTone = NonNullable<VariantProps<typeof textVariants>["tone"]>;

const TABULAR_NUMS: TextStyle = { fontVariant: ["tabular-nums"] };

export interface TextProps
  extends RNTextProps, VariantProps<typeof textVariants> {
  weight?: FontWeightName;
  mono?: boolean;
  numeric?: boolean;
  className?: string;
}

export function Text({
  variant,
  tone,
  weight,
  mono,
  numeric = false,
  className,
  style,
  ...props
}: TextProps) {
  const merged = cn(textVariants({ variant, tone }), className);
  const font = resolveFont({ className: merged, weight, mono });
  return (
    <RNText
      className={merged}
      style={[font, numeric ? TABULAR_NUMS : null, style]}
      {...props}
    />
  );
}
