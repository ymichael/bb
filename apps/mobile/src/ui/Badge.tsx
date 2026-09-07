import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { View } from "react-native";
import { cn } from "./cn";
import { Text } from "./Text";

const badgeVariants = cva(
  "flex-row items-center self-start rounded-md border px-2.5 py-0.5",
  {
    variants: {
      variant: {
        default: "border-transparent bg-foreground",
        secondary: "border-transparent bg-secondary",
        destructive: "border-transparent bg-destructive",
        outline: "border-border",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const badgeTextVariants = cva("text-xs font-semibold", {
  variants: {
    variant: {
      default: "text-background",
      secondary: "text-secondary-foreground",
      destructive: "text-destructive-foreground",
      outline: "text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode;
  className?: string;
}

export function Badge({ variant, children, className }: BadgeProps) {
  return (
    <View className={cn(badgeVariants({ variant }), className)}>
      {typeof children === "string" || typeof children === "number" ? (
        <Text className={cn(badgeTextVariants({ variant }))}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}
