import type { ComponentProps } from "react";
import type { StyleProp, ViewProps, ViewStyle } from "react-native";
import type Animated from "react-native-reanimated";

export type GlassSurfaceLayout = ComponentProps<typeof Animated.View>["layout"];

export interface GlassSurfaceProps extends ViewProps {
  style?: StyleProp<ViewStyle>;
  fallbackStyle?: StyleProp<ViewStyle>;
  glassStyle?: "regular" | "clear";
  tintColor?: string;
  interactive?: boolean;
  layout?: GlassSurfaceLayout;
}
