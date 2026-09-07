import Constants from "expo-constants";
import { useProfiles } from "@/app-shell";
import { sendShellCommand } from "@/lib/shell";
import { GroupedRow, Text, confirmDestructive, toast } from "@/ui";
import { GroupedScreen } from "./GroupedScreen";
import { HapticsSettingsRow } from "./HapticsSettingsRow";
import { LinkRow } from "./LinkRow";
import { settingsSectionHref } from "@/screens/shell/hrefs";
import { SettingsSection } from "./SettingsRows";
import { useBadgeColors } from "./settings-badges";

export function DeviceSettingsScreen() {
  const colors = useBadgeColors();
  const { profiles } = useProfiles();
  const version = String(Constants.expoConfig?.version ?? "0.0.0");
  const build = String(
    Constants.expoConfig?.ios?.buildNumber ??
      Constants.expoConfig?.runtimeVersion ??
      "dev",
  );

  return (
    <GroupedScreen testID="device-settings-screen">
      <SettingsSection
        title="This device"
        footnote="Stored on this phone. Other phones on the same server keep their own."
      >
        <HapticsSettingsRow />
        <LinkRow
          title="Appearance"
          badge={{
            icon: "Palette",
            symbol: "paintpalette",
            color: colors.gray,
          }}
          href={settingsSectionHref("appearance")}
          testID="device-appearance"
        />
        <LinkRow
          title="Servers"
          subtitle={
            profiles.length === 1 ? "1 server" : `${profiles.length} servers`
          }
          badge={{ icon: "Cloud", symbol: "server.rack", color: colors.blue }}
          href="/settings/servers"
          testID="device-servers"
        />
        <LinkRow
          title="Notifications"
          badge={{ icon: "Zap", symbol: "bell.badge", color: colors.red }}
          href={settingsSectionHref("notifications")}
          testID="device-notifications"
        />
      </SettingsSection>

      <SettingsSection
        title="Page"
        footnote="Use these when the web interface is blank, stuck, or out of date. Clearing removes the cached page and this device's session cookie; pairing and your servers are untouched."
      >
        <GroupedRow
          title="Reload the page"
          badge={{
            icon: "RotateCcw",
            symbol: "arrow.clockwise",
            color: colors.gray,
          }}
          onPress={() => {
            const delivered = sendShellCommand({ kind: "reload" });
            toast[delivered ? "success" : "info"](
              delivered ? "Reloading" : "Open the web interface first",
            );
          }}
          testID="device-reload-page"
        />
        <GroupedRow
          title="Clear website data"
          destructive
          badge={{ icon: "Trash2", symbol: "trash", color: colors.red }}
          onPress={() =>
            confirmDestructive({
              title: "Clear website data?",
              message:
                "The cached page and this device's session cookie are removed, then the page reloads. Your servers and pairing stay.",
              actionLabel: "Clear",
              onConfirm: () => {
                const delivered = sendShellCommand({
                  kind: "clear-website-data",
                });
                toast[delivered ? "success" : "info"](
                  delivered ? "Cleared" : "Open the web interface first",
                );
              },
            })
          }
          testID="device-clear-website-data"
        />
      </SettingsSection>

      <SettingsSection title="About">
        <GroupedRow
          title="Version"
          trailing={
            <Text className="text-sm text-muted-foreground">
              {version} ({build})
            </Text>
          }
          testID="device-version"
        />
      </SettingsSection>
    </GroupedScreen>
  );
}
