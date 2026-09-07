import { describe, expect, it, vi } from "vitest";
import { createPushRegistrationController } from "./push-registration-controller";
import type { PushNotificationsModule } from "./push-registration";
import { createMemoryPushStorage, createPushStore } from "./push-store";
import type { PushSubscriptionsApi } from "./push-subscriptions-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup() {
  const store = createPushStore(createMemoryPushStorage());
  const tokenGate = deferred<string>();
  let tokenListener: ((deviceToken: string) => void) | null = null;
  const notifications: PushNotificationsModule = {
    projectId: "eas",
    platform: "ios",
    getPermission: async () => "granted",
    requestPermission: async () => "granted",
    getExpoPushToken: vi.fn(() => tokenGate.promise),
    addTokenListener(listener) {
      tokenListener = listener;
      return () => {
        tokenListener = null;
      };
    },
    setBadgeCount: async () => undefined,
  };
  const api = {
    register: vi.fn<PushSubscriptionsApi["register"]>(async () => ({
      subscriptionId: "sub_1",
    })),
    unregister: vi.fn<PushSubscriptionsApi["unregister"]>(
      async () => undefined,
    ),
    list: vi.fn<PushSubscriptionsApi["list"]>(async () => []),
  };
  const controller = createPushRegistrationController({
    notifications,
    api,
    store,
    deviceLabel: "phone",
    now: () => 1,
  });
  return {
    store,
    notifications,
    api,
    controller,
    tokenGate,
    emitDeviceToken(deviceToken: string) {
      tokenListener?.(deviceToken);
    },
  };
}

const profile = { id: "p1", serverUrl: "https://a", mode: "direct" } as const;

describe("createPushRegistrationController", () => {
  it("coalesces concurrent syncs for one profile into one in-flight run plus a trailing run", async () => {
    const { controller, store, notifications, tokenGate, api } = setup();
    store.setEnabled(profile.id, true);
    const first = controller.sync(profile);
    const second = controller.sync(profile);
    expect(controller.getSnapshot().byProfileId.p1?.syncing).toBe(true);
    tokenGate.resolve("tok");
    expect(await first).toEqual({ action: "skipped", reason: "up-to-date" });
    expect(await second).toEqual({ action: "skipped", reason: "up-to-date" });
    expect(notifications.getExpoPushToken).toHaveBeenCalledTimes(2);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().byProfileId.p1).toMatchObject({
      syncing: false,
      lastOutcome: { action: "skipped", reason: "up-to-date" },
    });
  });

  it("unregisters and forgets profiles removed from the app", async () => {
    const { controller, store, api, tokenGate } = setup();
    tokenGate.resolve("tok");
    store.setEnabled("p1", true);
    await controller.sync(profile);
    store.setEnabled("p2", true);
    await controller.sync({
      id: "p2",
      serverUrl: "https://b",
      mode: "direct",
    });
    await controller.reconcileRemovedProfiles(["p2"]);
    expect(api.unregister).toHaveBeenCalledWith(
      "https://a",
      expect.objectContaining({
        subscriptionId: "sub_1",
        expoPushToken: "tok",
      }),
    );
    expect(store.registeredProfileIds()).toEqual(["p2"]);
    expect(store.isEnabled("p1")).toBe(false);
  });

  it("turning the toggle off removes the server row; on re-registers", async () => {
    const { controller, store, api, tokenGate } = setup();
    tokenGate.resolve("tok");
    expect(await controller.setEnabled(profile, true)).toEqual({
      action: "registered",
      expoPushToken: "tok",
    });
    expect(store.hasPrompted()).toBe(true);
    expect(await controller.setEnabled(profile, false)).toEqual({
      action: "unregistered",
    });
    expect(api.unregister).toHaveBeenCalledTimes(1);
    expect(store.isEnabled(profile.id)).toBe(false);
  });

  it("ignores repeated device token events and events caused by an active sync", async () => {
    const {
      controller,
      store,
      notifications,
      tokenGate,
      emitDeviceToken,
    } = setup();
    store.setEnabled(profile.id, true);
    tokenGate.resolve("expo-token");
    await controller.sync(profile);
    vi.mocked(notifications.getExpoPushToken).mockClear();

    const tokenEvents: Promise<void>[] = [];
    notifications.addTokenListener((deviceToken) => {
      tokenEvents.push(controller.handleTokenRolled([profile], deviceToken));
    });

    emitDeviceToken("device-token-1");
    emitDeviceToken("device-token-1");
    emitDeviceToken("device-token-1");
    await Promise.all(tokenEvents);
    expect(notifications.getExpoPushToken).toHaveBeenCalledTimes(1);

    emitDeviceToken("device-token-2");
    await tokenEvents.at(-1);
    expect(notifications.getExpoPushToken).toHaveBeenCalledTimes(2);

    const activeTokenGate = deferred<string>();
    vi.mocked(notifications.getExpoPushToken).mockImplementationOnce(
      () => activeTokenGate.promise,
    );
    const activeSync = controller.sync(profile);
    await vi.waitFor(() => {
      expect(notifications.getExpoPushToken).toHaveBeenCalledTimes(3);
    });
    emitDeviceToken("device-token-3");
    await tokenEvents.at(-1);
    expect(notifications.getExpoPushToken).toHaveBeenCalledTimes(3);
    activeTokenGate.resolve("expo-token");
    await activeSync;
  });
});
