import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import Animated from "react-native-reanimated";
import type { GlassSurfaceProps } from "./glass-surface-types";

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

let liquidGlass: boolean | null = null;

export function useLiquidGlass(): boolean {
  if (liquidGlass === null) {
    liquidGlass = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  }
  return liquidGlass;
}

export function GlassSurface({
  style,
  fallbackStyle,
  glassStyle = "regular",
  tintColor,
  interactive = false,
  layout,
  children,
  ...rest
}: GlassSurfaceProps) {
  if (!useLiquidGlass()) {
    return (
      <Animated.View layout={layout} style={[style, fallbackStyle]} {...rest}>
        {children}
      </Animated.View>
    );
  }
  return (
    <AnimatedGlassView
      layout={layout}
      glassEffectStyle={glassStyle}
      tintColor={tintColor}
      isInteractive={interactive}
      style={style}
      {...rest}
    >
      {children}
    </AnimatedGlassView>
  );
}

export type {
  GlassSurfaceLayout,
  GlassSurfaceProps,
} from "./glass-surface-types";
