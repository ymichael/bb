import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { View, type TextInput } from "react-native";
import { useProfiles } from "@/app-shell";
import {
  PROFILE_LABEL_MAX_LENGTH,
  probeServer,
  validateDirectServerUrl,
} from "@/lib/profiles";
import { describeError } from "@/lib/describe-error";
import { Button, GroupedRow, Input, Text, toast } from "@/ui";
import { connectEnrollHref, rawPathHref } from "../shell/hrefs";
import { GroupedScreen } from "./GroupedScreen";
import { useBadgeColors } from "./settings-badges";
import { SettingsSection } from "./SettingsRows";

type SubmitState =
  | { phase: "idle" }
  | { phase: "probing" }
  | { phase: "failed"; message: string }
  | { phase: "saving" };

function defaultLabel(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

const URL_HELP =
  "A LAN address, a Tailscale Serve URL, or http://127.0.0.1:<port> in the simulator.";

export function AddServerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ serverUrl?: string; next?: string }>();
  const colors = useBadgeColors();
  const { profiles, addProfile, setActiveProfile } = useProfiles();
  const [url, setUrl] = useState(params.serverUrl ?? "");
  const [label, setLabel] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ phase: "idle" });
  const labelRef = useRef<TextInput>(null);

  const validation = validateDirectServerUrl(url);
  const showUrlError = urlTouched && !validation.ok && url.trim().length > 0;
  const insecure = validation.ok && validation.warning === "insecure-http";
  const busy = submit.phase === "probing" || submit.phase === "saving";
  const firstRun = profiles.length === 0;

  const onSubmit = async () => {
    setUrlTouched(true);
    if (!validation.ok) {
      setSubmit({ phase: "failed", message: validation.message });
      return;
    }
    const { serverUrl } = validation;
    setSubmit({ phase: "probing" });
    const probe = await probeServer(serverUrl, fetch);
    if (!probe.ok) {
      const where =
        probe.stage === "health"
          ? "Could not reach the server"
          : "Reached the server, but it does not look like bb";
      setSubmit({ phase: "failed", message: `${where}: ${probe.error}` });
      return;
    }
    setSubmit({ phase: "saving" });
    try {
      const trimmedLabel = label.trim();
      const profile = await addProfile({
        mode: "direct",
        serverUrl,
        label: (trimmedLabel || defaultLabel(serverUrl)).slice(
          0,
          PROFILE_LABEL_MAX_LENGTH,
        ),
      });
      await setActiveProfile(profile.id);
      toast.success(`Added ${profile.label}`, {
        description: probe.advertisedServerUrl
          ? `Server reports ${probe.advertisedServerUrl}; keeping ${serverUrl}.`
          : undefined,
      });
      router.dismissTo("/");
      if (params.next?.startsWith("/")) router.push(rawPathHref(params.next));
    } catch (error) {
      setSubmit({ phase: "failed", message: describeError(error) });
    }
  };

  return (
    <>
      {}
      <Stack.Screen
        options={{ title: firstRun ? "Connect to a bb server" : "Add server" }}
      />
      <GroupedScreen testID="add-server-screen">
        <SettingsSection footnote="Pair through getbb.app from anywhere: scan or type a pairing code from bb Settings → Remote access.">
          <GroupedRow
            title="Connect with bb connect"
            badge={{ icon: "Globe", symbol: "globe", color: colors.blue }}
            trailing="chevron"
            onPress={() => router.push(connectEnrollHref())}
            disabled={busy}
            testID="add-server-connect"
          />
        </SettingsSection>

        <SettingsSection
          title="Server URL"
          footnote={
            showUrlError ? (
              <Text
                variant="footnote"
                tone="destructive"
                testID="server-url-error"
              >
                {validation.message}
              </Text>
            ) : insecure ? (
              <Text
                variant="footnote"
                tone="warning"
                testID="server-url-warning"
              >
                Plain http is unencrypted: anyone on this network can read your
                threads. Prefer https (Tailscale Serve) outside a trusted LAN.
              </Text>
            ) : (
              URL_HELP
            )
          }
        >
          <View className="px-1">
            <Input
              value={url}
              onChangeText={(next) => {
                setUrl(next);
                if (submit.phase === "failed") setSubmit({ phase: "idle" });
              }}
              onBlur={() => setUrlTouched(true)}
              placeholder="https://bb.example.ts.net"
              keyboardType="url"
              textContentType="URL"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => labelRef.current?.focus()}
              invalid={showUrlError}
              mono
              grouped
              editable={!busy}
              testID="server-url-input"
            />
          </View>
          <View className="px-1">
            <Input
              ref={labelRef}
              value={label}
              onChangeText={setLabel}
              placeholder={
                validation.ok
                  ? `Label (${defaultLabel(validation.serverUrl)})`
                  : "Label (optional)"
              }
              maxLength={PROFILE_LABEL_MAX_LENGTH}
              autoCapitalize="words"
              returnKeyType="go"
              onSubmitEditing={() => void onSubmit()}
              grouped
              editable={!busy}
              testID="server-label-input"
            />
          </View>
        </SettingsSection>

        <View className="gap-2">
          <Button
            onPress={() => void onSubmit()}
            loading={busy}
            disabled={url.trim().length === 0}
            icon="ArrowRight"
            iconPosition="right"
            testID="add-server-submit"
          >
            {submit.phase === "probing"
              ? "Checking server…"
              : submit.phase === "saving"
                ? "Saving…"
                : "Connect"}
          </Button>
          {submit.phase === "failed" ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-4"
              selectable
              testID="add-server-error"
            >
              {submit.message}
            </Text>
          ) : null}
        </View>
      </GroupedScreen>
    </>
  );
}
