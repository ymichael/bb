import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/theme/ThemeProvider";
import { cn } from "./cn";

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  const { tokens } = useTheme();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(
      withRepeat(
        withSequence(
          withTiming(0.5, { duration: 1000 }),
          withTiming(1, { duration: 1000 }),
        ),
        -1,
      ),
    );
  }, [opacity]);
  const pulse = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <View className={cn("overflow-hidden rounded-md", className)}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: tokens.surfaceSelected },
          pulse,
        ]}
      />
    </View>
  );
}
