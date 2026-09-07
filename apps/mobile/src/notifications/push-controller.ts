import {
  createPushRegistrationController,
  type PushRegistrationController,
} from "@/data/notifications";
import { describeThisDevice } from "./device-label";
import { getPushNotificationsModule } from "./expo-push-module";
import { getPushStore, getPushSubscriptionsApi } from "./push-storage";

let instance: PushRegistrationController | null = null;

export function getPushRegistrationController(): PushRegistrationController {
  instance ??= createPushRegistrationController({
    notifications: getPushNotificationsModule(),
    api: getPushSubscriptionsApi(),
    store: getPushStore(),
    deviceLabel: describeThisDevice(),
  });
  return instance;
}
