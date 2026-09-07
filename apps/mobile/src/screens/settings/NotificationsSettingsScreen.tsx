import { useProfiles } from "@/app-shell";
import { usePushRegistration } from "@/notifications";
import type { ServerProfile } from "@/lib/profiles";
import { ActionSheet, toast, useSheet } from "@/ui";
import { GroupedScreen } from "./GroupedScreen";
import {
  SettingsHint,
  SettingsSection,
  SettingsSwitchRow,
} from "./SettingsRows";

export function NotificationsSettingsScreen() {
  const { profiles } = useProfiles();
  return (
    <GroupedScreen scroll testID="notifications-settings-screen">
      {profiles.length === 0 ? (
        <SettingsSection title="Push notifications">
          <SettingsHint title="No servers" message="Add a server first." />
        </SettingsSection>
      ) : (
        profiles.map((profile) => (
          <PushProfileSection key={profile.id} profile={profile} />
        ))
      )}
    </GroupedScreen>
  );
}

function PushProfileSection({ profile }: { profile: ServerProfile }) {
  const push = usePushRegistration(profile);
  const permissionSheet = useSheet();
  const setEnabled = (enabled: boolean) => {
    void push.setEnabled(enabled).then((outcome) => {
      if (outcome.action !== "failed") return;
      toast.error(
        enabled
          ? "Could not turn on notifications"
          : "Could not turn off notifications",
        { description: outcome.error },
      );
    });
  };
  return (
    <>
      <SettingsSection title={profile.label}>
        <SettingsSwitchRow
          label="Push notifications"
          checked={push.enabled}
          disabled={(!push.available && !push.enabled) || push.syncing}
          pending={push.syncing}
          onCheckedChange={(enabled) => {
            if (enabled && push.permission !== "granted") {
              permissionSheet.present();
              return;
            }
            setEnabled(enabled);
          }}
          testID={`settings-push-${profile.id}`}
        />
        <SettingsHint
          title="Status"
          message={push.statusText}
          testID={`settings-push-status-${profile.id}`}
        />
      </SettingsSection>
      <ActionSheet
        controller={permissionSheet}
        title="Allow push notifications?"
        message={`bb will ask this phone for permission, then register it with ${profile.label}.`}
        actions={[
          {
            key: "enable",
            label: "Turn on notifications",
            icon: "Zap",
            onPress: () => setEnabled(true),
          },
        ]}
      />
    </>
  );
}
