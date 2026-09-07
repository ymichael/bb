import * as QuickActions from "expo-quick-actions";
import { useQuickActionCallback } from "expo-quick-actions/hooks";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { settingsSectionHref } from "@/screens/shell/hrefs";

const DEVICE_SETTINGS_ACTION_ID = "device-settings";

export function QuickActionsHandler() {
  const router = useRouter();

  useEffect(() => {
    QuickActions.setItems([
      {
        id: DEVICE_SETTINGS_ACTION_ID,
        title: "Device settings",
        subtitle: "Servers, haptics, and the web interface",
        icon: "symbol:gearshape",
      },
    ]).catch(() => undefined);
  }, []);

  useQuickActionCallback((action) => {
    if (action.id !== DEVICE_SETTINGS_ACTION_ID) return;
    router.navigate(settingsSectionHref("device"));
  });

  return null;
}
