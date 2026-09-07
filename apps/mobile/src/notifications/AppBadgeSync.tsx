import { useEffect } from "react";
import { AppState } from "react-native";
import { getPushNotificationsModule } from "./expo-push-module";

let desiredBadgeCount = 0;
const listeners = new Set<() => void>();

export function updateAppBadgeCount(count: number): void {
  desiredBadgeCount = count;
  for (const listener of listeners) listener();
}

export function AppBadgeSync() {
  const notifications = getPushNotificationsModule();

  useEffect(() => {
    const write = () => {
      void notifications
        .setBadgeCount(desiredBadgeCount)
        .catch(() => undefined);
    };
    listeners.add(write);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") write();
    });
    return () => {
      listeners.delete(write);
      subscription.remove();
    };
  }, [notifications]);

  return null;
}
