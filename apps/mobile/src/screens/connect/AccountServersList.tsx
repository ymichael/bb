import type { ConnectCredential } from "@bb/connect-client";
import { useState } from "react";
import { View } from "react-native";
import { useProfiles } from "@/app-shell";
import { accountServerProfile, useAccountServers } from "@/data/connect";
import { describeError } from "@/lib/describe-error";
import { Button, GroupedRow, Spinner, Text, toast } from "@/ui";
import { SettingsSection } from "../settings/SettingsRows";

export function AccountServersList({
  credential,
}: {
  credential: ConnectCredential;
}) {
  const { profiles, addProfile } = useProfiles();
  const { state, reload } = useAccountServers(credential);
  const [adding, setAdding] = useState<string | null>(null);

  const savedHandles = new Set(
    profiles.flatMap((profile) =>
      profile.mode === "connect"
        ? [`${profile.handle} ${profile.serverUrl}`]
        : [],
    ),
  );

  const add = async (server: { handle: string; name: string; url: string }) => {
    setAdding(server.handle);
    try {
      const profile = await addProfile(
        accountServerProfile(credential, server),
      );
      toast.success(`Added ${profile.label}`);
    } catch (error) {
      toast.error("Could not add server", {
        description: describeError(error),
      });
    } finally {
      setAdding(null);
    }
  };

  return (
    <SettingsSection
      title="Servers on this account"
      footnote="One pairing covers every server on the account: the credential and the session cookie are account-wide. Servers paired later show up here too."
      testID="connect-account-servers"
    >
      {state.status === "loading" || state.status === "idle" ? (
        <View className="flex-row items-center gap-2 px-4 py-3">
          <Spinner size="small" />
          <Text variant="footnote" tone="muted">
            Loading your servers…
          </Text>
        </View>
      ) : state.status === "error" ? (
        <View className="gap-2 px-4 py-3">
          <Text variant="footnote" tone="destructive" selectable>
            {state.failure.title}: {state.failure.message}
          </Text>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onPress={reload}
          >
            Try again
          </Button>
        </View>
      ) : state.servers.length === 0 ? (
        <View className="px-4 py-3">
          <Text variant="footnote" tone="muted">
            No servers are paired with this account yet.
          </Text>
        </View>
      ) : (
        state.servers.map((server) => {
          const isSelf = server.handle === state.selfHandle;
          const saved = savedHandles.has(`${server.handle} ${server.url}`);
          return (
            <GroupedRow
              key={server.handle}
              title={server.name}
              subtitle={server.url}
              leading="Globe"
              value={
                isSelf
                  ? "This server"
                  : saved
                    ? "Saved"
                    : server.live
                      ? "Online"
                      : "Offline"
              }
              trailing={
                isSelf ? (
                  "checkmark"
                ) : saved ? undefined : (
                  <Button
                    size="sm"
                    variant="outline"
                    icon="Plus"
                    loading={adding === server.handle}
                    disabled={adding !== null}
                    onPress={() => void add(server)}
                    testID={`account-server-add-${server.handle}`}
                  >
                    Add
                  </Button>
                )
              }
              testID={`account-server-${server.handle}`}
            />
          );
        })
      )}
    </SettingsSection>
  );
}
