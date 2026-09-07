import type { ConnectCredential } from "@bb/connect-client";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useProfiles } from "@/app-shell";
import {
  DEFAULT_CONNECT_APEX_URL,
  describeEnrollmentError,
  redeemEnrollment,
  resolveEnrollmentTarget,
  type ConnectPairingInput,
  type EnrollmentFailure,
  type EnrollmentTargetInput,
} from "@/data/connect";
import { describeError } from "@/lib/describe-error";
import type { SessionState } from "@/lib/session";
import { useTheme } from "@/theme";
import {
  Button,
  GroupedRow,
  Icon,
  Input,
  SheetProvider,
  Spinner,
  Text,
  toast,
} from "@/ui";
import { GroupedScreen } from "../settings/GroupedScreen";
import { useBadgeColors } from "../settings/settings-badges";
import { SettingsSection } from "../settings/SettingsRows";
import { AccountServersList } from "./AccountServersList";
import { ConnectScanner } from "./ConnectScanner";

const IS_IOS = process.env.EXPO_OS === "ios";

type Phase =
  | { kind: "form" }
  | { kind: "redeeming" }
  | { kind: "saving" }
  | { kind: "failed"; failure: EnrollmentFailure }
  | {
      kind: "enrolled";
      profileId: string;
      label: string;
      credential: ConnectCredential;
    };

interface FieldError {
  field: "code" | "server" | "apexUrl";
  message: string;
}

export function ConnectEnrollScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useBadgeColors();
  const params = useLocalSearchParams<{
    code?: string;
    serverUrl?: string;
    apex?: string;
    profileId?: string;
  }>();
  const { profiles, connection, addProfile, updateProfile, setActiveProfile } =
    useProfiles();
  const reauthProfile =
    params.profileId !== undefined
      ? (profiles.find(
          (profile) =>
            profile.id === params.profileId && profile.mode === "connect",
        ) ?? null)
      : null;
  const reauth = reauthProfile?.mode === "connect" ? reauthProfile : null;

  const [code, setCode] = useState(params.code ?? "");
  const [server, setServer] = useState(
    params.serverUrl ?? reauth?.serverUrl ?? "",
  );
  const [apexUrl, setApexUrl] = useState(params.apex ?? "");
  const [showAdvanced, setShowAdvanced] = useState(Boolean(params.apex));
  const [scanning, setScanning] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [fieldError, setFieldError] = useState<FieldError | null>(null);

  const busy = phase.kind === "redeeming" || phase.kind === "saving";
  const firstRun = profiles.length === 0;
  const session: SessionState | null =
    phase.kind === "enrolled" && connection?.profile.id === phase.profileId
      ? connection.session
      : null;

  const submitTarget = async (input: EnrollmentTargetInput) => {
    setFieldError(null);
    const target = resolveEnrollmentTarget(input);
    if (!target.ok) {
      setFieldError({ field: target.field, message: target.message });
      return;
    }
    setPhase({ kind: "redeeming" });
    try {
      const redeemed = await redeemEnrollment({
        apexUrl: target.apexUrl,
        code: target.code,
        label: reauth?.label,
      });
      setPhase({ kind: "saving" });
      let profileId: string;
      if (reauth) {
        const updated = await updateProfile(reauth.id, {
          serverUrl: redeemed.profile.serverUrl,
          handle: redeemed.profile.handle,
          credential: redeemed.profile.credential,
        });
        profileId = updated.id;
      } else {
        const added = await addProfile(redeemed.profile);
        profileId = added.id;
      }
      await setActiveProfile(profileId);
      setPhase({
        kind: "enrolled",
        profileId,
        label: reauth?.label ?? redeemed.profile.label,
        credential: redeemed.credential,
      });
      toast.success(
        reauth
          ? `Paired ${reauth.label} again`
          : `Paired with ${redeemed.profile.label}`,
      );
    } catch (error) {
      setPhase({ kind: "failed", failure: describeEnrollmentError(error) });
    }
  };

  const submit = () => void submitTarget({ code, server, apexUrl });

  const onScanned = (input: ConnectPairingInput) => {
    setScanning(false);
    setCode(input.code);
    if (input.serverUrl) setServer(input.serverUrl);
    if (input.apexUrl) {
      setApexUrl(input.apexUrl);
      setShowAdvanced(true);
    }
    void submitTarget({
      code: input.code,
      server: input.serverUrl ?? server,
      apexUrl: input.apexUrl ?? apexUrl,
    });
  };

  const done = () => router.dismissTo("/");

  const openDirectUrlForm = () => {
    const state = navigation.getState();
    const below = state ? state.routes[state.index - 1] : undefined;
    if (below?.name === "settings/servers/add") router.back();
    else router.replace("/settings/servers/add");
  };

  if (phase.kind === "enrolled") {
    return (
      <>
        <Stack.Screen
          options={{
            title: reauth ? "Paired again" : "Paired with bb connect",
          }}
        />
        {IS_IOS ? (
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              variant="done"
              accessibilityLabel="Done"
              onPress={done}
            >
              Done
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        ) : null}
        <GroupedScreen testID="connect-enrolled-screen">
          <SettingsSection footnote="This phone is now a device on your getbb.app account. You can revoke it any time in the dashboard under Machines.">
            <View
              className="flex-row items-center gap-3 px-4 py-3"
              testID="connect-enrolled-card"
            >
              <Icon
                name="CircleCheck"
                symbol="checkmark.circle.fill"
                size={28}
                color={colors.green}
              />
              <View className="min-w-0 flex-1">
                <Text variant="headline" numberOfLines={1}>
                  {phase.label}
                </Text>
                <Text variant="caption" mono numberOfLines={1} selectable>
                  {phase.credential.serverUrl}
                </Text>
                <SessionStatusLine session={session} />
              </View>
            </View>
          </SettingsSection>

          <AccountServersList credential={phase.credential} />

          <Button
            onPress={done}
            icon="ArrowRight"
            iconPosition="right"
            testID="connect-done"
          >
            Done
          </Button>
        </GroupedScreen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: reauth
            ? `Sign in again to ${reauth.label}`
            : firstRun
              ? "Connect to getbb.app"
              : "Pair with bb connect",
        }}
      />
      {IS_IOS ? (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            accessibilityLabel="Cancel"
            disabled={busy}
            onPress={() => router.back()}
          >
            Cancel
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : null}
      {}
      <SheetProvider>
        <GroupedScreen testID="connect-screen">
          <SettingsSection
            footnote={
              reauth
                ? "This phone's access was revoked or has expired. Generate a new pairing code on the server and enter it here; your saved server keeps its place."
                : "Pair this phone with your bb server through getbb.app. Generate a code in bb Settings → Remote access → Add mobile device, or run `bb connect machine-code`."
            }
          >
            <GroupedRow
              title={scanning ? "Stop scanning" : "Scan QR code"}
              badge={{
                icon: "GridView",
                symbol: "qrcode.viewfinder",
                color: scanning ? colors.gray : colors.blue,
              }}
              onPress={() => setScanning((value) => !value)}
              disabled={busy}
              testID="connect-scan-toggle"
            />
          </SettingsSection>
          {scanning ? (
            <ConnectScanner active={!busy} onScanned={onScanned} />
          ) : null}

          <SettingsSection
            title="Pairing code"
            footnote={
              fieldError?.field === "code" ? (
                <Text variant="footnote" tone="destructive">
                  {fieldError.message}
                </Text>
              ) : undefined
            }
          >
            <View className="px-1">
              <Input
                value={code}
                onChangeText={(next) => {
                  setCode(next);
                  if (phase.kind === "failed") setPhase({ kind: "form" });
                }}
                placeholder="ABCD-EFGH"
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="next"
                invalid={fieldError?.field === "code"}
                mono
                grouped
                editable={!busy}
                testID="connect-code-input"
              />
            </View>
          </SettingsSection>

          <SettingsSection
            title="Server (handle or URL)"
            footnote={
              fieldError?.field === "server" ? (
                <Text variant="footnote" tone="destructive">
                  {fieldError.message}
                </Text>
              ) : reauth ? (
                "The server is fixed when signing in again."
              ) : (
                "Optional: the code already names the server. A URL also sets the bb connect address for self-hosted gates."
              )
            }
          >
            <View className="px-1">
              <Input
                value={server}
                onChangeText={setServer}
                placeholder="bee or https://bee.getbb.app"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={submit}
                invalid={fieldError?.field === "server"}
                mono
                grouped
                editable={!busy && reauth === null}
                testID="connect-server-input"
              />
            </View>
          </SettingsSection>

          {showAdvanced ? (
            <SettingsSection
              title="bb connect address"
              footnote={
                fieldError?.field === "apexUrl" ? (
                  <Text variant="footnote" tone="destructive">
                    {fieldError.message}
                  </Text>
                ) : (
                  "The self-hosted bb connect gate this phone pairs through."
                )
              }
            >
              <View className="px-1">
                <Input
                  value={apexUrl}
                  onChangeText={setApexUrl}
                  placeholder={DEFAULT_CONNECT_APEX_URL}
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  invalid={fieldError?.field === "apexUrl"}
                  mono
                  grouped
                  editable={!busy}
                  testID="connect-apex-input"
                />
              </View>
            </SettingsSection>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onPress={() => setShowAdvanced(true)}
              testID="connect-advanced-toggle"
            >
              Self-hosted bb connect…
            </Button>
          )}

          <View className="gap-2">
            {phase.kind === "failed" ? (
              <View className="gap-0.5 px-4" testID="connect-error">
                <Text
                  variant="footnote"
                  weight="semibold"
                  tone="destructive"
                  selectable
                >
                  {phase.failure.title}
                </Text>
                <Text variant="footnote" tone="destructive" selectable>
                  {phase.failure.message}
                </Text>
              </View>
            ) : null}
            <Button
              onPress={submit}
              loading={busy}
              disabled={code.trim().length === 0}
              icon="ArrowRight"
              iconPosition="right"
              testID="connect-submit"
            >
              {phase.kind === "redeeming"
                ? "Pairing…"
                : phase.kind === "saving"
                  ? "Saving…"
                  : reauth
                    ? "Sign in again"
                    : "Pair"}
            </Button>
            {!reauth ? (
              <Button
                variant="ghost"
                onPress={openDirectUrlForm}
                disabled={busy}
                testID="connect-use-direct"
              >
                Use a direct URL instead
              </Button>
            ) : null}
          </View>
        </GroupedScreen>
      </SheetProvider>
    </>
  );
}

function SessionStatusLine({ session }: { session: SessionState | null }) {
  const { tokens } = useTheme();
  if (session === null || session.status === "idle") {
    return (
      <View className="flex-row items-center gap-2 pt-1">
        <Spinner size="small" />
        <Text variant="caption">Activating…</Text>
      </View>
    );
  }
  switch (session.status) {
    case "authenticating":
      return (
        <View className="flex-row items-center gap-2 pt-1">
          <Spinner size="small" />
          <Text variant="caption" testID="connect-session-authenticating">
            Signing in…
          </Text>
        </View>
      );
    case "authenticated":
      return (
        <View className="flex-row items-center gap-2 pt-1">
          <Icon
            name="Check"
            size={14}
            weight="semibold"
            color={tokens.success}
          />
          <Text
            variant="caption"
            tone="success"
            testID="connect-session-authenticated"
          >
            Signed in. Session renews automatically.
          </Text>
        </View>
      );
    case "auth-required":
      return (
        <Text
          variant="caption"
          tone="destructive"
          selectable
          testID="connect-session-auth-required"
        >
          bb connect rejected the new credential: {session.detail}
        </Text>
      );
    case "error":
      return (
        <Text
          variant="caption"
          tone="warning"
          selectable
          testID="connect-session-error"
        >
          Could not sign in yet ({describeError(session.detail)}). Retrying…
        </Text>
      );
  }
}
