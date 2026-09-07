import type { PushPlatform } from "./push-contract";
import type { PushRegistrationRecord, PushStore } from "./push-store";
import {
  PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS,
  type PushSubscriptionsApi,
} from "./push-subscriptions-api";

export type PushPermissionState = "granted" | "denied" | "undetermined";

export interface PushNotificationsModule {
  readonly projectId: string | null;
  readonly platform: PushPlatform;
  getPermission(): Promise<PushPermissionState>;
  requestPermission(): Promise<PushPermissionState>;
  getExpoPushToken(projectId: string): Promise<string>;
  addTokenListener(listener: (deviceToken: string) => void): () => void;
  setBadgeCount(count: number): Promise<void>;
}

export type PushSkipReason =
  | "disabled"
  | "insecure-http"
  | "no-project-id"
  | "permission-undetermined"
  | "permission-denied"
  | "up-to-date";

export type PushSyncOutcome =
  | { action: "registered"; expoPushToken: string }
  | { action: "unregistered" }
  | { action: "skipped"; reason: PushSkipReason }
  | {
      action: "failed";
      step: "token" | "register" | "unregister";
      error: string;
    };

export interface PushSyncDeps {
  notifications: PushNotificationsModule;
  api: PushSubscriptionsApi;
  store: PushStore;
  deviceLabel: string;
  now?: () => number;
  refreshAfterMs?: number;
}

export interface PushSyncProfile {
  id: string;
  serverUrl: string;
  mode: "direct" | "connect";
}

export const PUSH_REGISTRATION_REFRESH_MS = 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isPushRegistrationAllowed(profile: PushSyncProfile): boolean {
  if (profile.mode === "connect") return true;
  try {
    const url = new URL(profile.serverUrl);
    return url.protocol !== "http:" || LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type PushSyncDecision =
  | { action: "skip"; reason: Exclude<PushSkipReason, "up-to-date"> }
  | { action: "unregister" }
  | { action: "fetch-token" };

export function decidePushSync(input: {
  enabled: boolean;
  projectId: string | null;
  permission: PushPermissionState;
  existing: PushRegistrationRecord | null;
}): PushSyncDecision {
  if (!input.enabled) {
    return input.existing
      ? { action: "unregister" }
      : { action: "skip", reason: "disabled" };
  }
  if (input.projectId === null) {
    return { action: "skip", reason: "no-project-id" };
  }
  if (input.permission === "denied") {
    return input.existing
      ? { action: "unregister" }
      : { action: "skip", reason: "permission-denied" };
  }
  if (input.permission === "undetermined") {
    return { action: "skip", reason: "permission-undetermined" };
  }
  return { action: "fetch-token" };
}

export function shouldReregister(input: {
  existing: PushRegistrationRecord | null;
  expoPushToken: string;
  platform: PushPlatform;
  serverUrl: string;
  now: number;
  refreshAfterMs: number;
}): boolean {
  const { existing } = input;
  if (!existing) return true;
  if (existing.expoPushToken !== input.expoPushToken) return true;
  if (existing.platform !== input.platform) return true;
  if (existing.serverUrl !== input.serverUrl) return true;
  return input.now - existing.registeredAt >= input.refreshAfterMs;
}

export async function syncPushRegistration(
  deps: PushSyncDeps,
  profile: PushSyncProfile,
): Promise<PushSyncOutcome> {
  const now = deps.now ?? Date.now;
  const refreshAfterMs = deps.refreshAfterMs ?? PUSH_REGISTRATION_REFRESH_MS;
  const { notifications, api, store } = deps;
  const existing = store.getRegistration(profile.id);
  if (!isPushRegistrationAllowed(profile)) {
    if (existing) return unregisterPushRegistration(deps, profile.id);
    return { action: "skipped", reason: "insecure-http" };
  }
  const decision = decidePushSync({
    enabled: store.isEnabled(profile.id),
    projectId: notifications.projectId,
    permission: await notifications.getPermission(),
    existing,
  });
  if (decision.action === "skip") {
    return { action: "skipped", reason: decision.reason };
  }
  if (decision.action === "unregister") {
    return unregisterPushRegistration(deps, profile.id);
  }

  let expoPushToken: string;
  try {
    expoPushToken = await notifications.getExpoPushToken(
      notifications.projectId ?? "",
    );
  } catch (error) {
    return { action: "failed", step: "token", error: describe(error) };
  }
  const platform = notifications.platform;
  if (
    !shouldReregister({
      existing,
      expoPushToken,
      platform,
      serverUrl: profile.serverUrl,
      now: now(),
      refreshAfterMs,
    })
  ) {
    return { action: "skipped", reason: "up-to-date" };
  }
  if (
    existing &&
    (existing.expoPushToken !== expoPushToken ||
      existing.serverUrl !== profile.serverUrl)
  ) {
    try {
      await api.unregister(existing.serverUrl, existing);
    } catch {}
  }
  let subscriptionId: string;
  try {
    ({ subscriptionId } = await api.register(profile.serverUrl, {
      expoPushToken,
      platform,
      deviceLabel: deps.deviceLabel,
    }));
  } catch (error) {
    return { action: "failed", step: "register", error: describe(error) };
  }
  store.setRegistration(profile.id, {
    subscriptionId,
    expoPushToken,
    tokenSuffix: expoPushToken.slice(-6),
    platform,
    serverUrl: profile.serverUrl,
    registeredAt: now(),
  });
  return { action: "registered", expoPushToken };
}

export async function unregisterPushRegistration(
  deps: Pick<PushSyncDeps, "api" | "store">,
  profileId: string,
): Promise<PushSyncOutcome> {
  const existing = deps.store.getRegistration(profileId);
  if (!existing) return { action: "skipped", reason: "disabled" };
  try {
    await deps.api.unregister(existing.serverUrl, existing);
  } catch (error) {
    return { action: "failed", step: "unregister", error: describe(error) };
  }
  deps.store.setRegistration(profileId, null);
  return { action: "unregistered" };
}

export async function enablePushForProfile(
  deps: Pick<PushSyncDeps, "notifications" | "store">,
  profileId: string,
): Promise<PushPermissionState> {
  let permission = await deps.notifications.getPermission();
  if (permission === "undetermined") {
    permission = await deps.notifications.requestPermission();
  }
  deps.store.markPrompted();
  deps.store.setEnabled(profileId, permission === "granted");
  return permission;
}

export function describePushStatus(input: {
  profile: PushSyncProfile;
  projectId: string | null;
  enabled: boolean;
  permission: PushPermissionState | null;
  registration: PushRegistrationRecord | null;
  lastOutcome: PushSyncOutcome | null;
}): string {
  if (!isPushRegistrationAllowed(input.profile)) {
    return "Push needs HTTPS or bb connect";
  }
  if (input.projectId === null) {
    return "Push unavailable until the app is built with EAS";
  }
  if (!input.enabled) return "Off";
  if (input.permission === "denied") {
    return "Notifications are blocked in system settings";
  }
  if (input.lastOutcome?.action === "failed") {
    if (
      input.lastOutcome.error === PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS
    ) {
      return PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS;
    }
    return `Could not register: ${input.lastOutcome.error}`;
  }
  if (input.registration) return "On · registered with this server";
  if (input.permission === "undetermined") return "Waiting for permission";
  return "Registering…";
}
