import type { ErrorBoundaryProps } from "expo-router";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const PALETTE = {
  light: {
    background: "#ffffff",
    label: "#000000",
    secondaryLabel: "#666666",
    tint: Platform.select({ ios: "#007aff", default: "#111111" }),
    tintLabel: "#ffffff",
  },
  dark: {
    background: "#000000",
    label: "#ffffff",
    secondaryLabel: "#8c8c8c",
    tint: Platform.select({ ios: "#0a84ff", default: "#f2f2f2" }),
    tintLabel: Platform.select({ ios: "#ffffff", default: "#111111" }),
  },
} as const;

const MONO_FAMILY = Platform.select({ ios: "Menlo", default: "monospace" });

export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const insets = useSafeAreaInsets();
  const colors = PALETTE[useColorScheme() === "dark" ? "dark" : "light"];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        padding: 24,
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 24,
        gap: 12,
      }}
      testID="route-error"
    >
      <Text style={{ fontSize: 22, fontWeight: "700", color: colors.label }}>
        Something went wrong
      </Text>
      <Text
        selectable
        style={{
          fontSize: 13,
          lineHeight: 18,
          color: colors.secondaryLabel,
          fontFamily: MONO_FAMILY,
        }}
      >
        {error.message}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void retry()}
          style={({ pressed }) => ({
            backgroundColor: colors.tint,
            opacity: pressed ? 0.6 : 1,
            paddingHorizontal: 20,
            paddingVertical: 11,
            borderRadius: Platform.select({ ios: 22, default: 8 }),
            borderCurve: "continuous",
          })}
        >
          <Text
            style={{ color: colors.tintLabel, fontSize: 17, fontWeight: "600" }}
          >
            Try again
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
