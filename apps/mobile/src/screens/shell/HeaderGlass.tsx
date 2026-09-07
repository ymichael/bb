import { useHeaderHeight } from "expo-router/react-navigation";
import { StyleSheet, View } from "react-native";
import { GlassSurface } from "@/ui";

export function HeaderGlass() {
  const height = useHeaderHeight();
  return (
    <View style={[styles.clip, { height }]} pointerEvents="none">
      <GlassSurface style={styles.glass} />
    </View>
  );
}

const RIM_BLEED = 24;

const styles = StyleSheet.create({
  clip: { width: "100%", overflow: "hidden" },
  glass: {
    position: "absolute",
    top: -RIM_BLEED,
    left: -RIM_BLEED,
    right: -RIM_BLEED,
    bottom: 0,
  },
});
