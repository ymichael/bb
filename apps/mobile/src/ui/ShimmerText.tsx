import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Text, type TextProps } from "./Text";

export interface ShimmerTextProps extends TextProps {
  active?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}

export function ShimmerText({
  active = true,
  containerStyle,
  ...props
}: ShimmerTextProps) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!active) {
      opacity.set(withTiming(1, { duration: 150 }));
      return;
    }
    opacity.set(
      withRepeat(
        withSequence(
          withTiming(0.45, { duration: 700 }),
          withTiming(1, { duration: 700 }),
        ),
        -1,
      ),
    );
  }, [active, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View style={[containerStyle, animated]}>
      <Text {...props} />
    </Animated.View>
  );
}
