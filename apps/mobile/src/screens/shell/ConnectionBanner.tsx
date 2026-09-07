import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  FadeInUp,
  FadeOutUp,
  LinearTransition,
} from "react-native-reanimated";
import { useConnectionBanner, useProfiles } from "@/app-shell";
import type { ConnectionBannerKind } from "@/lib/connection";
import { haptic } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { Icon, Text, type IconName } from "@/ui";
import { connectEnrollHref } from "./hrefs";

interface BannerCopy {
  icon: IconName;
  message: (label: string) => string;
  destructive: boolean;
}

const COPY: Record<Exclude<ConnectionBannerKind, "hidden">, BannerCopy> = {
  connecting: {
    icon: "Loading",
    message: (label) => `Connecting to ${label}…`,
    destructive: false,
  },
  reconnecting: {
    icon: "ArrowReloadHorizontal",
    message: (label) => `Connection to ${label} lost. Reconnecting…`,
    destructive: false,
  },
  "auth-required": {
    icon: "Lock",
    message: (label) => `${label} needs to be paired again.`,
    destructive: true,
  },
  "auth-error": {
    icon: "AlertTriangle",
    message: (label) => `Could not sign in to ${label}. Retrying…`,
    destructive: false,
  },
};

const ENTER_MS = 220;
const EXIT_MS = 160;

const CARD_RADIUS = 12;

const INSET_STYLE: ViewStyle = { marginHorizontal: 16, marginTop: 8 };

interface ConnectionBannerProps {
  inset?: boolean;
}

export function ConnectionBanner({ inset = false }: ConnectionBannerProps) {
  const router = useRouter();
  const kind = useConnectionBanner();
  const { activeProfile } = useProfiles();
  const { tokens } = useTheme();

  useEffect(() => {
    if (kind === "auth-required") haptic("warning");
  }, [kind]);

  if (kind === "hidden" || !activeProfile) return null;
  const copy = COPY[kind];
  const color = copy.destructive ? tokens.destructiveText : tokens.warningText;
  const reauth =
    kind === "auth-required" && activeProfile.mode === "connect"
      ? () => router.push(connectEnrollHref({ profileId: activeProfile.id }))
      : null;
  const message = copy.message(activeProfile.label);
  const cardStyle: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: CARD_RADIUS,
    borderCurve: "continuous",
    backgroundColor: copy.destructive
      ? tokens.surfaceDestructive
      : tokens.surfaceAttention,
  };
  const content = (
    <>
      <Icon name={copy.icon} size={18} weight="semibold" color={color} />
      <Text
        variant="footnote"
        weight="medium"
        numberOfLines={2}
        className="flex-1"
        style={{ color }}
        testID={`connection-banner-${kind}`}
      >
        {message}
      </Text>
      {reauth ? (
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 8,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: tokens.surfaceDestructiveBorder,
          }}
          testID="connection-banner-reauth"
        >
          <Text variant="footnote" weight="semibold" style={{ color }}>
            Sign in again
          </Text>
        </View>
      ) : null}
    </>
  );
  return (
    <Animated.View
      entering={FadeInUp.duration(ENTER_MS)}
      exiting={FadeOutUp.duration(EXIT_MS)}
      layout={LinearTransition.duration(ENTER_MS)}
      style={inset ? INSET_STYLE : undefined}
    >
      {reauth ? (
        <Pressable
          testID="connection-banner"
          accessibilityRole="button"
          accessibilityLabel={`${message} Sign in again`}
          accessibilityLiveRegion="polite"
          onPress={reauth}
          style={({ pressed }) => [cardStyle, { opacity: pressed ? 0.7 : 1 }]}
        >
          {content}
        </Pressable>
      ) : (
        <View
          testID="connection-banner"
          accessibilityLiveRegion="polite"
          style={cardStyle}
        >
          {content}
        </View>
      )}
    </Animated.View>
  );
}
