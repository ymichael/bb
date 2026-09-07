import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { useProfiles } from "@/app-shell";
import { describeError } from "@/lib/describe-error";
import { haptic } from "@/lib/haptics";
import type { ServerProfile } from "@/lib/profiles";
import {
  ActionSheet,
  confirmDestructive,
  GroupedRow,
  toast,
  useSheet,
  type ActionSheetAction,
} from "@/ui";
import { connectEnrollHref } from "../shell/hrefs";
import { GroupedScreen } from "./GroupedScreen";
import {
  HeaderIconButton,
  ICON_ROW_SEPARATOR_INSET,
  SettingsSection,
} from "./SettingsRows";

const IS_IOS = process.env.EXPO_OS === "ios";

export function ServersScreen() {
  const router = useRouter();
  const { profiles, activeProfile, setActiveProfile, removeProfile } =
    useProfiles();
  const menu = useSheet();
  const [target, setTarget] = useState<ServerProfile | null>(null);

  const addServer = () => router.push("/settings/servers/add");

  const activate = (profile: ServerProfile) => {
    if (profile.id === activeProfile?.id) return;
    setActiveProfile(profile.id).catch((error: unknown) => {
      toast.error("Could not switch server", {
        description: describeError(error),
      });
    });
  };

  const remove = (profile: ServerProfile) => {
    removeProfile(profile.id)
      .then(() => toast.success(`Removed ${profile.label}`))
      .catch((error: unknown) => {
        toast.error("Could not remove server", {
          description: describeError(error),
        });
      });
  };

  const confirmRemove = (profile: ServerProfile) =>
    confirmDestructive({
      title: `Remove ${profile.label}?`,
      message:
        profile.mode === "connect"
          ? "The app forgets this server and its device credential. The phone stays listed under Machines in the getbb.app dashboard until you revoke it there."
          : "The app forgets this server. Nothing on the server changes.",
      actionLabel: "Remove",
      onConfirm: () => remove(profile),
    });

  const actionsFor = (profile: ServerProfile): ActionSheetAction[] => [
    {
      key: "activate",
      label: "Use this server",
      icon: "Check",
      disabled: profile.id === activeProfile?.id,
      onPress: () => activate(profile),
    },
    ...(profile.mode === "connect"
      ? [
          {
            key: "reauth",
            label: "Sign in again",
            icon: "Lock" as const,
            onPress: () => {
              router.push(connectEnrollHref({ profileId: profile.id }));
            },
          },
        ]
      : []),
    {
      key: "remove",
      label: "Remove",
      icon: "Trash2",
      destructive: true,
      onPress: () => confirmRemove(profile),
    },
  ];

  const openMenu = (profile: ServerProfile) => {
    haptic("impact-heavy");
    setTarget(profile);
    menu.present();
  };

  return (
    <>
      {IS_IOS ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon="plus"
            accessibilityLabel="Add server"
            onPress={addServer}
          />
        </Stack.Toolbar>
      ) : (
        <Stack.Screen
          options={{
            headerRight: () => (
              <HeaderIconButton
                icon="Plus"
                accessibilityLabel="Add server"
                onPress={addServer}
                testID="servers-add"
              />
            ),
          }}
        />
      )}
      <GroupedScreen testID="servers-screen">
        {profiles.length === 0 ? (
          <SettingsSection footnote="No servers saved yet. Pair through getbb.app or enter a direct URL.">
            <GroupedRow
              title="Add server"
              leading="Plus"
              leadingTone="primary"
              onPress={addServer}
            />
          </SettingsSection>
        ) : (
          <SettingsSection
            title="Saved servers"
            separatorInset={ICON_ROW_SEPARATOR_INSET}
            footnote={
              IS_IOS
                ? "Tap a server to make it active."
                : "Tap a server to make it active. Long-press for more."
            }
          >
            {profiles.map((profile) => (
              <GroupedRow
                key={profile.id}
                title={profile.label}
                subtitle={
                  profile.mode === "connect"
                    ? `@${profile.handle} · ${profile.serverUrl}`
                    : profile.serverUrl
                }
                leading={profile.mode === "connect" ? "Globe" : "Laptop"}
                value={profile.mode === "connect" ? "bb connect" : "Direct"}
                trailing={
                  profile.id === activeProfile?.id ? "checkmark" : undefined
                }
                onPress={() => activate(profile)}
                onLongPress={() => openMenu(profile)}
                testID={`server-row-${profile.id}`}
              />
            ))}
          </SettingsSection>
        )}
      </GroupedScreen>

      <ActionSheet
        controller={menu}
        title={target?.label}
        message={target?.serverUrl}
        actions={target ? actionsFor(target) : []}
      />
    </>
  );
}
