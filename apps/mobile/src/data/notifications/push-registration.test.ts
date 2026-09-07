import { describe, expect, it, vi } from "vitest";
import {
  decidePushSync,
  describePushStatus,
  enablePushForProfile,
  isPushRegistrationAllowed,
  shouldReregister,
  syncPushRegistration,
  unregisterPushRegistration,
  type PushNotificationsModule,
  type PushPermissionState,
} from "./push-registration";
import { createMemoryPushStorage, createPushStore } from "./push-store";
import {
  PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS,
  type PushSubscriptionsApi,
} from "./push-subscriptions-api";

interface FakeModuleOptions {
  projectId?: string | null;
  permission?: PushPermissionState;
  token?: string | (() => Promise<string>);
}

function fakeModule(options: FakeModuleOptions = {}) {
  let permission: PushPermissionState = options.permission ?? "granted";
  const listeners = new Set<(deviceToken: string) => void>();
  const requestPermissionMock = vi.fn(
    async (): Promise<PushPermissionState> => {
      permission = "granted";
      return permission;
    },
  );
  const module: PushNotificationsModule & {
    requestPermissionMock: typeof requestPermissionMock;
    rollToken(deviceToken: string): void;
  } = {
    projectId:
      options.projectId === undefined ? "eas-project" : options.projectId,
    platform: "ios",
    getPermission: async () => permission,
    requestPermissionMock,
    requestPermission: () => requestPermissionMock(),
    getExpoPushToken: vi.fn(async () => {
      const token = options.token ?? "ExponentPushToken[abc]";
      return typeof token === "function" ? token() : token;
    }),
    addTokenListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setBadgeCount: async () => undefined,
    rollToken: (deviceToken) => {
      for (const listener of listeners) listener(deviceToken);
    },
  };
  return module;
}

function fakeApi() {
  const api = {
    register: vi.fn<PushSubscriptionsApi["register"]>(async () => ({
      subscriptionId: "sub_1",
    })),
    unregister: vi.fn<PushSubscriptionsApi["unregister"]>(
      async () => undefined,
    ),
    list: vi.fn<PushSubscriptionsApi["list"]>(async () => []),
  };
  return api;
}

const profile = {
  id: "p1",
  serverUrl: "https://sawyer.getbb.app",
  mode: "direct",
} as const;

function setup(moduleOptions?: FakeModuleOptions) {
  const store = createPushStore(createMemoryPushStorage());
  const notifications = fakeModule(moduleOptions);
  const api = fakeApi();
  let clock = 1_000;
  const deps = {
    notifications,
    api,
    store,
    deviceLabel: "Sawyer's iPhone",
    now: () => clock,
    refreshAfterMs: 1_000_000,
  };
  return {
    store,
    notifications,
    api,
    deps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("decidePushSync", () => {
  const existing = {
    subscriptionId: "sub_0",
    expoPushToken: "t",
    tokenSuffix: "t",
    platform: "ios" as const,
    serverUrl: profile.serverUrl,
    registeredAt: 0,
  };

  it("never touches the server while the toggle is off and nothing is registered", () => {
    expect(
      decidePushSync({
        enabled: false,
        projectId: "x",
        permission: "granted",
        existing: null,
      }),
    ).toEqual({ action: "skip", reason: "disabled" });
  });

  it("unregisters when the toggle goes off or the permission is revoked after registering", () => {
    expect(
      decidePushSync({
        enabled: false,
        projectId: "x",
        permission: "granted",
        existing,
      }),
    ).toEqual({ action: "unregister" });
    expect(
      decidePushSync({
        enabled: true,
        projectId: "x",
        permission: "denied",
        existing,
      }),
    ).toEqual({ action: "unregister" });
  });

  it("skips gracefully without an EAS project id, even when enabled and granted", () => {
    expect(
      decidePushSync({
        enabled: true,
        projectId: null,
        permission: "granted",
        existing: null,
      }),
    ).toEqual({ action: "skip", reason: "no-project-id" });
  });

  it("does not request permission on its own", () => {
    expect(
      decidePushSync({
        enabled: true,
        projectId: "x",
        permission: "undetermined",
        existing: null,
      }),
    ).toEqual({ action: "skip", reason: "permission-undetermined" });
    expect(
      decidePushSync({
        enabled: true,
        projectId: "x",
        permission: "denied",
        existing: null,
      }),
    ).toEqual({ action: "skip", reason: "permission-denied" });
  });

  it("fetches a token once enabled, granted, and configured", () => {
    expect(
      decidePushSync({
        enabled: true,
        projectId: "x",
        permission: "granted",
        existing: null,
      }),
    ).toEqual({ action: "fetch-token" });
  });
});

describe("shouldReregister", () => {
  const base = {
    expoPushToken: "t1",
    platform: "ios" as const,
    serverUrl: "https://a",
    now: 10_000,
    refreshAfterMs: 5_000,
  };
  const existing = {
    subscriptionId: "sub_0",
    expoPushToken: "t1",
    tokenSuffix: "t1",
    platform: "ios" as const,
    serverUrl: "https://a",
    registeredAt: 8_000,
  };

  it("re-registers on a new token, platform, or server, and when the record is stale", () => {
    expect(shouldReregister({ ...base, existing: null })).toBe(true);
    expect(shouldReregister({ ...base, existing })).toBe(false);
    expect(shouldReregister({ ...base, existing, expoPushToken: "t2" })).toBe(
      true,
    );
    expect(shouldReregister({ ...base, existing, platform: "android" })).toBe(
      true,
    );
    expect(
      shouldReregister({ ...base, existing, serverUrl: "https://b" }),
    ).toBe(true);
    expect(shouldReregister({ ...base, existing, now: 13_000 })).toBe(true);
  });
});

describe("syncPushRegistration", () => {
  it("refuses plain HTTP outside loopback without asking for a token", async () => {
    const { store, deps, notifications, api } = setup();
    const insecure = {
      id: "p1",
      serverUrl: "http://192.168.1.20:3000",
      mode: "direct",
    } as const;
    store.setEnabled(insecure.id, true);
    expect(await syncPushRegistration(deps, insecure)).toEqual({
      action: "skipped",
      reason: "insecure-http",
    });
    expect(notifications.getExpoPushToken).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
    expect(
      describePushStatus({
        profile: insecure,
        projectId: "eas-project",
        enabled: true,
        permission: "granted",
        registration: null,
        lastOutcome: null,
      }),
    ).toBe("Push needs HTTPS or bb connect");
  });

  it("removes an existing registration after a profile changes to plain HTTP", async () => {
    const { store, deps, api } = setup();
    store.setEnabled(profile.id, true);
    await syncPushRegistration(deps, profile);
    expect(
      await syncPushRegistration(deps, {
        ...profile,
        serverUrl: "http://192.168.1.20:3000",
      }),
    ).toEqual({ action: "unregistered" });
    expect(api.unregister).toHaveBeenCalledTimes(1);
    expect(store.getRegistration(profile.id)).toBeNull();
  });

  it("allows HTTPS, exact loopback HTTP hosts, and bb connect", () => {
    expect(isPushRegistrationAllowed(profile)).toBe(true);
    for (const serverUrl of [
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://[::1]:3000",
    ]) {
      expect(
        isPushRegistrationAllowed({ id: "p", serverUrl, mode: "direct" }),
      ).toBe(true);
    }
    expect(
      isPushRegistrationAllowed({
        id: "p",
        serverUrl: "http://192.168.1.20:3000",
        mode: "connect",
      }),
    ).toBe(true);
    expect(
      isPushRegistrationAllowed({
        id: "p",
        serverUrl: "http://127.0.0.2:3000",
        mode: "direct",
      }),
    ).toBe(false);
  });

  it("registers once enabled and granted, then reports up-to-date until the token changes", async () => {
    const { store, deps, api, notifications } = setup();
    store.setEnabled(profile.id, true);

    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "registered",
      expoPushToken: "ExponentPushToken[abc]",
    });
    expect(api.register).toHaveBeenCalledWith(profile.serverUrl, {
      expoPushToken: "ExponentPushToken[abc]",
      platform: "ios",
      deviceLabel: "Sawyer's iPhone",
    });
    expect(store.getRegistration(profile.id)).toMatchObject({
      subscriptionId: "sub_1",
      expoPushToken: "ExponentPushToken[abc]",
      serverUrl: profile.serverUrl,
      registeredAt: 1_000,
    });

    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "skipped",
      reason: "up-to-date",
    });
    expect(api.register).toHaveBeenCalledTimes(1);

    vi.mocked(notifications.getExpoPushToken).mockResolvedValueOnce(
      "ExponentPushToken[new]",
    );
    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "registered",
      expoPushToken: "ExponentPushToken[new]",
    });
    expect(api.unregister).toHaveBeenCalledWith(
      profile.serverUrl,
      expect.objectContaining({
        subscriptionId: "sub_1",
        expoPushToken: "ExponentPushToken[abc]",
      }),
    );
    expect(api.register).toHaveBeenCalledTimes(2);
  });

  it("refreshes a registration older than the refresh window", async () => {
    const { store, deps, api, advance } = setup();
    store.setEnabled(profile.id, true);
    await syncPushRegistration(deps, profile);
    advance(1_000_000);
    expect(await syncPushRegistration(deps, profile)).toMatchObject({
      action: "registered",
    });
    expect(api.register).toHaveBeenCalledTimes(2);
    expect(api.unregister).not.toHaveBeenCalled();
  });

  it("unregisters when the toggle is turned off after a registration", async () => {
    const { store, deps, api } = setup();
    store.setEnabled(profile.id, true);
    await syncPushRegistration(deps, profile);
    store.setEnabled(profile.id, false);
    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "unregistered",
    });
    expect(api.unregister).toHaveBeenCalledWith(
      profile.serverUrl,
      expect.objectContaining({ subscriptionId: "sub_1" }),
    );
    expect(store.getRegistration(profile.id)).toBeNull();
    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "skipped",
      reason: "disabled",
    });
  });

  it("skips without an EAS project id and never asks the module for a token", async () => {
    const { store, deps, notifications, api } = setup({ projectId: null });
    store.setEnabled(profile.id, true);
    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "skipped",
      reason: "no-project-id",
    });
    expect(notifications.getExpoPushToken).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
  });

  it("reports token and registration failures without writing a record", async () => {
    const { store, deps, api } = setup({
      token: async () => {
        throw new Error("offline");
      },
    });
    store.setEnabled(profile.id, true);
    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "failed",
      step: "token",
      error: "offline",
    });
    expect(store.getRegistration(profile.id)).toBeNull();

    const ok = setup();
    ok.store.setEnabled(profile.id, true);
    ok.api.register.mockRejectedValueOnce(new Error("HTTP 500: boom"));
    expect(await syncPushRegistration(ok.deps, profile)).toEqual({
      action: "failed",
      step: "register",
      error: "HTTP 500: boom",
    });
    expect(ok.store.getRegistration(profile.id)).toBeNull();
    expect(api.register).not.toHaveBeenCalled();
  });

  it("reports when the server disables the push notifications plugin", async () => {
    const { store, deps, api } = setup();
    store.setEnabled(profile.id, true);
    api.register.mockRejectedValueOnce(
      new Error(PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS),
    );
    const outcome = await syncPushRegistration(deps, profile);
    expect(outcome).toEqual({
      action: "failed",
      step: "register",
      error: PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS,
    });
    expect(
      describePushStatus({
        profile,
        projectId: "eas-project",
        enabled: true,
        permission: "granted",
        registration: null,
        lastOutcome: outcome,
      }),
    ).toBe(PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS);
  });

  it("unregisters a removed profile from the server it was registered with", async () => {
    const { store, deps, api } = setup();
    store.setEnabled(profile.id, true);
    await syncPushRegistration(deps, profile);
    expect(await unregisterPushRegistration(deps, profile.id)).toEqual({
      action: "unregistered",
    });
    expect(api.unregister).toHaveBeenCalledWith(
      profile.serverUrl,
      expect.objectContaining({ subscriptionId: "sub_1" }),
    );
    expect(store.registeredProfileIds()).toEqual([]);
  });

  it("keeps the record when unregistering fails so a later sync retries", async () => {
    const { store, deps, api } = setup();
    store.setEnabled(profile.id, true);
    await syncPushRegistration(deps, profile);
    api.unregister.mockRejectedValueOnce(new Error("offline"));
    expect(await unregisterPushRegistration(deps, profile.id)).toEqual({
      action: "failed",
      step: "unregister",
      error: "offline",
    });
    expect(store.getRegistration(profile.id)).not.toBeNull();
  });
});

describe("enablePushForProfile", () => {
  it("requests the OS permission once and records the toggle and the prompt", async () => {
    const { store, deps, notifications } = setup({
      permission: "undetermined",
    });
    expect(await enablePushForProfile(deps, profile.id)).toBe("granted");
    expect(notifications.requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(store.isEnabled(profile.id)).toBe(true);
    expect(store.hasPrompted()).toBe(true);
    await enablePushForProfile(deps, "p2");
    expect(notifications.requestPermissionMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the toggle off when the user denies", async () => {
    const { store, deps, notifications } = setup({
      permission: "undetermined",
    });
    notifications.requestPermissionMock.mockResolvedValueOnce("denied");
    expect(await enablePushForProfile(deps, profile.id)).toBe("denied");
    expect(store.isEnabled(profile.id)).toBe(false);
    expect(store.hasPrompted()).toBe(true);
  });
});
