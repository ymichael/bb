import type { NativeStackNavigationOptions } from "expo-router";

export const LIST_SCREEN_OPTIONS = {
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
} as const satisfies NativeStackNavigationOptions;

export const MODAL_SCREEN_OPTIONS = {
  presentation: "modal",
} as const satisfies NativeStackNavigationOptions;
