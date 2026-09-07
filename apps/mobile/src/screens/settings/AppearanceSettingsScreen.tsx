import { View } from "react-native";
import { useTheme, type ThemeModePreference } from "@/theme";
import { GroupedScreen } from "./GroupedScreen";
import { SegmentedChoice } from "./SegmentedChoice";
import { SettingsSection } from "./SettingsRows";

const MODES: readonly { value: ThemeModePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearanceSettingsScreen() {
  const theme = useTheme();
  return (
    <GroupedScreen testID="appearance-settings-screen">
      <SettingsSection
        title="Mode"
        footnote="Applies to this phone's own screens. The web interface follows the appearance you set on the server."
      >
        <View className="px-4 py-3" testID="appearance-mode">
          <SegmentedChoice
            options={MODES}
            value={theme.preference}
            onChange={(mode) => theme.setMode(mode)}
            testIDPrefix="appearance-mode"
          />
        </View>
      </SettingsSection>
    </GroupedScreen>
  );
}
