import {
  MOBILE_BRIDGE_VERSION,
  buildBridgeInjectionScript,
  type NativeShellHandshake,
} from "@bb/mobile-bridge";
import Constants from "expo-constants";
import CookieManager from "@react-native-cookies/cookies";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useProfiles } from "@/app-shell";
import {
  buildShellUrl,
  isExternallyOpenable,
  isShellNavigation,
  resolveShellScreenState,
  shellPathFromUrl,
  shouldReloadForSession,
  subscribeToShellCommands,
  type ShellLoadPhase,
} from "@/lib/shell";
import { getShellPreferenceStore } from "@/lib/shell/shell-preference-store";
import { settingsSectionHref } from "@/screens/shell/hrefs";
import { useTheme } from "@/theme";
import { Button, EmptyStatePanel, Spinner, Text } from "@/ui";
import { Linking } from "react-native";
import { useShellBridge } from "./useShellBridge";

const APP_VERSION = String(Constants.expoConfig?.version ?? "0.0.0");

const IDLE_SESSION = { status: "idle" } as const;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function ProfileWebViewScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ profileId?: string; path?: string }>();
  const { status, profiles, activeProfile, connection, setActiveProfile } =
    useProfiles();
  const preferences = getShellPreferenceStore();

  const requestedProfileId = firstParam(params.profileId);
  const requestedPath = firstParam(params.path);

  useEffect(() => {
    if (requestedProfileId === undefined) return;
    if (activeProfile?.id === requestedProfileId) return;
    if (!profiles.some((profile) => profile.id === requestedProfileId)) return;
    void setActiveProfile(requestedProfileId);
  }, [activeProfile?.id, profiles, requestedProfileId, setActiveProfile]);

  const profile = activeProfile;
  const session = connection?.session ?? IDLE_SESSION;
  const webViewRef = useRef<WebView>(null);
  const [load, setLoad] = useState<ShellLoadPhase>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const currentPathRef = useRef<string>("/");

  const initialPath = useMemo(() => {
    if (requestedPath !== undefined && requestedPath.length > 0) {
      return requestedPath;
    }
    if (profile === null) return "/";
    return preferences.getLastPath(profile.id) ?? "/";
  }, [preferences, profile, requestedPath]);

  const sourceUrl = useMemo(
    () =>
      profile === null ? null : buildShellUrl(profile.serverUrl, initialPath),
    [initialPath, profile],
  );

  const rememberPath = useCallback(
    (path: string) => {
      currentPathRef.current = path;
      if (profile !== null) preferences.setLastPath(profile.id, path);
    },
    [preferences, profile],
  );

  const openDeviceSettings = useCallback(() => {
    router.push(settingsSectionHref("device"));
  }, [router]);

  const bridge = useShellBridge(webViewRef, {
    onReady: (path) => {
      setLoad({ kind: "ready" });
      rememberPath(path);
    },
    onPath: rememberPath,
    onOpenNative: (screen) => {
      if (screen === "device-settings") openDeviceSettings();
    },
  });

  useEffect(
    () =>
      subscribeToShellCommands((command) => {
        if (command.kind === "clear-website-data") {
          webViewRef.current?.clearCache(true);
          void CookieManager.clearAll(false);
          void CookieManager.clearAll(true);
        }
        setLoad({ kind: "loading" });
        setReloadKey((value) => value + 1);
      }),
    [],
  );

  const safeArea = useMemo(
    () => ({
      top: insets.top,
      right: insets.right,
      bottom: insets.bottom,
      left: insets.left,
    }),
    [insets.bottom, insets.left, insets.right, insets.top],
  );
  const hasSentHandshake = useRef(false);
  useEffect(() => {
    if (!hasSentHandshake.current) {
      hasSentHandshake.current = true;
      return;
    }
    bridge.send({ type: "safe-area", safeArea });
  }, [bridge, safeArea]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") bridge.send({ type: "resume" });
    });
    return () => subscription.remove();
  }, [bridge]);

  const previousSession = useRef(session);
  useEffect(() => {
    if (shouldReloadForSession(previousSession.current, session)) {
      setReloadKey((value) => value + 1);
      setLoad({ kind: "loading" });
    }
    previousSession.current = session;
  }, [session]);

  const handshake = useMemo<NativeShellHandshake | null>(() => {
    if (profile === null || sourceUrl === null) return null;
    return {
      bridgeVersion: MOBILE_BRIDGE_VERSION,
      appVersion: APP_VERSION,
      platform: Platform.OS === "android" ? "android" : "ios",
      profileMode: profile.mode,
      secureContext: sourceUrl.startsWith("https://"),
      safeArea,
      capabilities: [
        "haptic",
        "badge",
        "share",
        "open-external",
        "safe-area",
        "open-native",
      ],
    };
  }, [profile, safeArea, sourceUrl]);

  const retry = useCallback(() => {
    setLoad({ kind: "loading" });
    setReloadKey((value) => value + 1);
  }, []);

  const screen = resolveShellScreenState({
    storeReady: status === "ready",
    hasAnyProfile: profiles.length > 0,
    hasProfile: profile !== null && sourceUrl !== null,
    session,
    load,
  });

  if (screen.kind === "no-profile") {
    return <Redirect href="/settings/servers/add" />;
  }

  if (screen.kind === "loading") {
    return (
      <View
        className="flex-1 items-center justify-center gap-3"
        testID="shell-loading"
      >
        <Spinner />
        <Text className="text-sm text-muted-foreground">{screen.message}</Text>
      </View>
    );
  }

  if (screen.kind === "error") {
    return (
      <View className="flex-1 justify-center p-6" testID="shell-error">
        <EmptyStatePanel>
          <View className="items-center gap-3">
            <Text className="text-center text-base font-semibold">
              {screen.title}
            </Text>
            <Text className="text-center text-sm text-muted-foreground">
              {screen.detail}
            </Text>
            {screen.action === "retry" ? (
              <Button testID="shell-retry" onPress={retry}>
                Try again
              </Button>
            ) : null}
            {screen.action === "re-pair" ? (
              <Button
                testID="shell-repair"
                onPress={() =>
                  router.push(
                    profile === null
                      ? "/settings/servers"
                      : `/connect?profileId=${encodeURIComponent(profile.id)}`,
                  )
                }
              >
                Pair again
              </Button>
            ) : null}
            {}
            <Button
              variant="ghost"
              testID="shell-device-settings"
              onPress={openDeviceSettings}
            >
              Device settings
            </Button>
          </View>
        </EmptyStatePanel>
      </View>
    );
  }

  if (profile === null || sourceUrl === null || handshake === null) return null;

  return (
    <View className="flex-1 bg-background" testID="shell-webview">
      <WebView
        key={`${profile.id}#${sourceUrl}#${reloadKey}`}
        ref={webViewRef}
        source={{ uri: sourceUrl }}
        style={{ backgroundColor: tokens.background }}
        sharedCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        hideKeyboardAccessoryView
        allowsBackForwardNavigationGestures={false}
        bounces={false}
        pullToRefreshEnabled={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        webviewDebuggingEnabled={__DEV__}
        injectedJavaScriptBeforeContentLoaded={buildBridgeInjectionScript(
          handshake,
        )}
        onMessage={bridge.onMessage}
        onShouldStartLoadWithRequest={(request) => {
          if (isShellNavigation(request.url, profile.serverUrl)) return true;
          if (isExternallyOpenable(request.url)) {
            void Linking.openURL(request.url).catch(() => undefined);
          }
          return false;
        }}
        onNavigationStateChange={(state) => {
          const path = shellPathFromUrl(state.url, profile.serverUrl);
          if (path !== null) rememberPath(path);
        }}
        onLoadEnd={() =>
          setLoad((previous) =>
            previous.kind === "loading" ? { kind: "ready" } : previous,
          )
        }
        onError={(event) =>
          setLoad({
            kind: "failed",
            detail: event.nativeEvent.description || "Unknown error",
          })
        }
        onHttpError={(event) => {
          const { statusCode } = event.nativeEvent;
          if (statusCode >= 400)
            setLoad({ kind: "http-error", status: statusCode });
        }}
        onContentProcessDidTerminate={retry}
      />
    </View>
  );
}
