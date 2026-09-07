// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientDelivery } from "./client.js";

class TestNotification {
  static permission: NotificationPermission = "granted";
  static instances: TestNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    TestNotification.instances.push(this);
  }
}
const message = {
  id: "event-1",
  title: "Finished",
  body: "Ready",
  threadId: "thread-1",
  channels: ["web"],
};

beforeEach(() => {
  TestNotification.permission = "granted";
  TestNotification.instances = [];
  localStorage.clear();
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client system notifications", () => {
  it.each([
    { platform: "macos", icon: undefined },
    { platform: "linux", icon: "http://localhost:3000/icon-192.png" },
    { platform: "web", icon: "http://localhost:3000/icon-192.png" },
  ])(
    "uses the appropriate notification icon on $platform",
    async ({ platform, icon }) => {
      if (platform !== "web") vi.stubGlobal("bbDesktop", { platform });
      const delivery = createClientDelivery(vi.fn());
      await delivery.deliver(
        { ...message, channels: [platform === "web" ? "web" : "desktop"] },
        true,
      );
      expect(TestNotification.instances).toHaveLength(1);
      expect(TestNotification.instances[0]?.options.icon).toBe(icon);
      delivery.dispose();
    },
  );

  it("deduplicates windows, navigates on click, and cleans up on disposal", async () => {
    const navigate = vi.fn();
    const first = createClientDelivery(navigate);
    const second = createClientDelivery(navigate);
    await first.deliver(message, true);
    await second.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(1);
    const notification = TestNotification.instances[0]!;
    expect(notification.options.body).toBe("Ready");
    notification.onclick?.();
    expect(window.focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("thread-1");
    await first.deliver({ ...message, id: "event-2" }, true);
    first.dispose();
    expect(TestNotification.instances[1]?.close).toHaveBeenCalled();
    await first.deliver({ ...message, id: "event-3" }, true);
    expect(TestNotification.instances).toHaveLength(2);
    second.dispose();
  });

  it("respects channel, permission, disabled state, and malformed input", async () => {
    const delivery = createClientDelivery(vi.fn());
    await delivery.deliver(message, false);
    await delivery.deliver({ ...message, channels: ["desktop"] }, true);
    await delivery.deliver({ ...message, threadId: 3 }, true);
    TestNotification.permission = "denied";
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(0);
    vi.stubGlobal("bbDesktop", {});
    TestNotification.permission = "granted";
    await delivery.deliver(message, true);
    await delivery.deliver({ ...message, channels: ["desktop"] }, true);
    expect(TestNotification.instances).toHaveLength(1);
    delivery.dispose();
  });

  it("does not deliver in the mobile WebView and survives unavailable storage", async () => {
    const delivery = createClientDelivery(vi.fn());
    vi.stubGlobal("bb", { native: {} });
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(0);
    vi.stubGlobal("bb", undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(1);
    delivery.dispose();
  });
});
