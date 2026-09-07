import {
  DarkTheme,
  DefaultTheme,
  type NativeStackNavigationOptions,
  Stack,
  ThemeProvider as NavigationThemeProvider,
} from "expo-router";
import { useMemo } from "react";
import { Platform } from "react-native";
import { useTheme } from "@/theme";
import { HeaderGlass } from "./HeaderGlass";
import { LIST_SCREEN_OPTIONS, MODAL_SCREEN_OPTIONS } from "./screen-options";

const IS_IOS = process.env.EXPO_OS === "ios";
const IOS_MAJOR = IS_IOS ? Number.parseInt(String(Platform.Version), 10) : 0;
const IOS_SYSTEM_BAR = IOS_MAJOR >= 26;
const GLASS_HEADER = IS_IOS && IOS_SYSTEM_BAR;

const renderHeaderGlass = () => <HeaderGlass />;

export function RootNavigator() {
  const { tokens, mode } = useTheme();
  const navigationTheme = useMemo(() => {
    const base = mode === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: tokens.primary,
        background: tokens.background,
        card: tokens.background,
        text: tokens.foreground,
        border: tokens.border,
        notification: tokens.destructive,
      },
    };
  }, [mode, tokens]);
  const headerSurface: NativeStackNavigationOptions = IS_IOS
    ? GLASS_HEADER
      ? {
          headerTransparent: true,
          headerBlurEffect: "none",
          headerBackground: renderHeaderGlass,
          headerLargeStyle: { backgroundColor: "transparent" },
          scrollEdgeEffects: { top: "hidden" },
        }
      : { headerTransparent: true, headerBlurEffect: "systemChromeMaterial" }
    : { headerStyle: { backgroundColor: tokens.background } };
  const listScreen: NativeStackNavigationOptions = GLASS_HEADER
    ? {
        ...LIST_SCREEN_OPTIONS,
        headerBackground: undefined,
        headerBlurEffect: "regular",
      }
    : LIST_SCREEN_OPTIONS;
  const hiddenHeader: NativeStackNavigationOptions = {
    headerShown: false,
    headerBackground: undefined,
  };
  return (
    <NavigationThemeProvider value={navigationTheme}>
      <Stack
        screenOptions={{
          headerShown: true,
          ...headerSurface,
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          headerTintColor: tokens.primary,
          headerTitleStyle: { fontWeight: "600", color: tokens.foreground },
          headerLargeTitleStyle: { color: tokens.foreground },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: tokens.background },
        }}
      >
        <Stack.Screen name="index" options={hiddenHeader} />
        <Stack.Screen
          name="webview"
          options={{ ...hiddenHeader, gestureEnabled: false }}
        />
        <Stack.Screen
          name="settings/device"
          options={{ title: "This device", ...listScreen }}
        />
        <Stack.Screen
          name="settings/appearance"
          options={{ title: "Appearance" }}
        />
        <Stack.Screen
          name="settings/notifications"
          options={{ title: "Notifications", ...listScreen }}
        />
        <Stack.Screen
          name="settings/servers/index"
          options={{ title: "Servers", ...listScreen }}
        />
        <Stack.Screen
          name="settings/servers/add"
          options={{ title: "Add server", ...MODAL_SCREEN_OPTIONS }}
        />
        <Stack.Screen
          name="connect/index"
          options={{ title: "bb connect", ...MODAL_SCREEN_OPTIONS }}
        />
        <Stack.Screen name="dev/webview-spike" options={hiddenHeader} />
        <Stack.Screen name="e2e/reset" options={hiddenHeader} />
      </Stack>
    </NavigationThemeProvider>
  );
}
