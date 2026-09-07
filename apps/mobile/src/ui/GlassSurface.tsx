import Animated from "react-native-reanimated";
import type { GlassSurfaceProps } from "./glass-surface-types";

export function useLiquidGlass(): boolean {
  return false;
}

export function GlassSurface({
  style,
  fallbackStyle,
  glassStyle: _glassStyle,
  tintColor: _tintColor,
  interactive: _interactive,
  layout,
  children,
  ...rest
}: GlassSurfaceProps) {
  return (
    <Animated.View layout={layout} style={[style, fallbackStyle]} {...rest}>
      {children}
    </Animated.View>
  );
}

export type {
  GlassSurfaceLayout,
  GlassSurfaceProps,
} from "./glass-surface-types";
