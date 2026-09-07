import { StyleSheet, View } from "react-native";
import { useTheme } from "@/theme/ThemeProvider";
import { cn } from "./cn";

export const SEPARATOR_INSET = 16;

export interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
  inset?: number | boolean;
  className?: string;
}

export function Separator({
  orientation = "horizontal",
  inset = 0,
  className,
}: SeparatorProps) {
  const { tokens } = useTheme();
  const insetPx =
    inset === true ? SEPARATOR_INSET : inset === false ? 0 : inset;
  const horizontal = orientation === "horizontal";
  return (
    <View
      accessibilityElementsHidden
      className={cn("shrink-0", horizontal ? "w-full" : "h-full", className)}
      style={[
        { backgroundColor: tokens.borderHairline },
        horizontal
          ? { height: StyleSheet.hairlineWidth }
          : { width: StyleSheet.hairlineWidth },
        horizontal && insetPx ? { marginLeft: insetPx } : null,
      ]}
    />
  );
}
