import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTheme } from "@/theme";

type ScreenTitleProps = ComponentProps<typeof Stack.Title>;

export function ScreenTitle({ style, largeStyle, ...props }: ScreenTitleProps) {
  const { tokens } = useTheme();
  return (
    <Stack.Title
      {...props}
      style={[{ color: tokens.foreground, fontWeight: "600" }, style]}
      largeStyle={[{ color: tokens.foreground }, largeStyle]}
    />
  );
}
