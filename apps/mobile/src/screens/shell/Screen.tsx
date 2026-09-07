import type { ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { ConnectionBanner } from "./ConnectionBanner";

const IS_IOS = process.env.EXPO_OS === "ios";

const FLOATING_BANNER_GAP = 8;

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  banner?: boolean;
  surface?: "background" | "grouped";
  testID?: string;
}

export function Screen({
  children,
  scroll = true,
  contentStyle,
  banner = true,
  surface = "background",
  testID,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const rootClassName =
    surface === "grouped"
      ? "flex-1 bg-surface-grouped"
      : "flex-1 bg-background";
  if (scroll) {
    return (
      <ScrollView
        className={rootClassName}
        testID={testID}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          {
            padding: 16,
            gap: 24,
            paddingBottom: IS_IOS ? 32 : insets.bottom + 32,
          },
          contentStyle,
        ]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {banner ? <ConnectionBanner /> : null}
        {children}
      </ScrollView>
    );
  }
  return (
    <View className={rootClassName} testID={testID} collapsable={false}>
      {banner && !IS_IOS ? <ConnectionBanner inset /> : null}
      <View className="flex-1">{children}</View>
      {banner && IS_IOS ? <FloatingConnectionBanner /> : null}
    </View>
  );
}

function FloatingConnectionBanner() {
  return (
    <SafeAreaProvider style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <FloatingConnectionBannerBody />
    </SafeAreaProvider>
  );
}

function FloatingConnectionBannerBody() {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + FLOATING_BANNER_GAP,
        left: 0,
        right: 0,
        paddingHorizontal: 16,
      }}
    >
      <ConnectionBanner />
    </View>
  );
}
