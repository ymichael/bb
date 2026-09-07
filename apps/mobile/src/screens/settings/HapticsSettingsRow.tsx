import { useHapticsEnabled } from "@/lib/haptics";
import { useBadgeColors } from "./settings-badges";
import { SettingsSwitchRow } from "./SettingsRows";

export function HapticsSettingsRow() {
  const [enabled, setEnabled] = useHapticsEnabled();
  const colors = useBadgeColors();
  return (
    <SettingsSwitchRow
      label="Haptics"
      badge={{
        icon: "Smartphone",
        symbol: "iphone.radiowaves.left.and.right",
        color: colors.gray,
      }}
      checked={enabled}
      onCheckedChange={setEnabled}
      testID="settings-haptics"
    />
  );
}
