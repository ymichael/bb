import type { SFSymbolEffect } from "expo-image";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { ImageStyle, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/theme/ThemeProvider";
import { ICON_MAP, type IconName } from "./icon-map";
import type { SFSymbol, SFSymbolWeight } from "./sf-symbol-map";

export const ICON_STROKE_WIDTH = 1.75;
export const ICON_SIZE_DEFAULT = 20;

export type IconStyle = ViewStyle & ImageStyle;

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  weight?: SFSymbolWeight;
  symbol?: SFSymbol;
  effect?: SFSymbolEffect;
  style?: StyleProp<IconStyle>;
  accessibilityLabel?: string;
}

export function HugeIcon({
  name,
  size = ICON_SIZE_DEFAULT,
  color,
  strokeWidth = ICON_STROKE_WIDTH,
  style,
  accessibilityLabel,
}: IconProps) {
  const { tokens } = useTheme();
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      size={size}
      color={color ?? tokens.foreground}
      strokeWidth={strokeWidth}
      style={style}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={accessibilityLabel === undefined}
      importantForAccessibility={
        accessibilityLabel === undefined ? "no-hide-descendants" : "auto"
      }
    />
  );
}
