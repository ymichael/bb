import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type {
  PushNotificationsModule,
  PushPermissionState,
  PushPlatform,
} from "@/data/notifications";

export function getEasProjectId(): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra === "object" && extra !== null && "eas" in extra) {
    const eas: unknown = (extra as { eas?: unknown }).eas;
    if (typeof eas === "object" && eas !== null && "projectId" in eas) {
      const projectId: unknown = (eas as { projectId?: unknown }).projectId;
      if (typeof projectId === "string" && projectId.length > 0) {
        return projectId;
      }
    }
  }
  const easConfigId = Constants.easConfig?.projectId;
  return typeof easConfigId === "string" && easConfigId.length > 0
    ? easConfigId
    : null;
}

function toPermissionState(
  status: Notifications.NotificationPermissionsStatus,
): PushPermissionState {
  if (
    status.granted ||
    status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  ) {
    return "granted";
  }
  return status.status === "undetermined" || status.canAskAgain
    ? "undetermined"
    : "denied";
}

function currentPlatform(): PushPlatform {
  return Platform.OS === "android" ? "android" : "ios";
}

export const ANDROID_DEFAULT_CHANNEL_ID = "threads";

export function createExpoPushModule(): PushNotificationsModule {
  return {
    projectId: getEasProjectId(),
    platform: currentPlatform(),
    async getPermission() {
      return toPermissionState(await Notifications.getPermissionsAsync());
    },
    async requestPermission() {
      return toPermissionState(
        await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true },
        }),
      );
    },
    async getExpoPushToken(projectId) {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync(
          ANDROID_DEFAULT_CHANNEL_ID,
          {
            name: "Threads",
            importance: Notifications.AndroidImportance.MAX,
          },
        );
      }
      const token = await Notifications.getExpoPushTokenAsync({ projectId });
      return token.data;
    },
    addTokenListener(listener) {
      const subscription = Notifications.addPushTokenListener((event) => {
        const token =
          typeof event.data === "object" &&
          event.data !== null &&
          "data" in event.data
            ? event.data.data
            : event.data;
        listener(String(token));
      });
      return () => subscription.remove();
    },
    setBadgeCount(count) {
      return Notifications.setBadgeCountAsync(count).then(() => undefined);
    },
  };
}

let instance: PushNotificationsModule | null = null;

export function getPushNotificationsModule(): PushNotificationsModule {
  instance ??= createExpoPushModule();
  return instance;
}
