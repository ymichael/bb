import { describe, expect, it } from "vitest";
import { createMemoryPushStorage, createPushStore } from "./push-store";

describe("createPushStore", () => {
  it("persists toggles, registrations and the prompt flag across instances", () => {
    const storage = createMemoryPushStorage();
    const store = createPushStore(storage);
    store.setEnabled("p1", true);
    store.setRegistration("p1", {
      subscriptionId: "s1",
      expoPushToken: "t",
      tokenSuffix: "t",
      platform: "ios",
      serverUrl: "https://a",
      registeredAt: 5,
    });
    store.setRegistration("p2", {
      subscriptionId: null,
      expoPushToken: "t",
      tokenSuffix: "t",
      platform: "ios",
      serverUrl: "https://b",
      registeredAt: 6,
    });
    store.markPrompted();

    const reloaded = createPushStore(storage);
    expect(reloaded.isEnabled("p1")).toBe(true);
    expect(reloaded.isEnabled("p2")).toBe(false);
    expect(reloaded.getRegistration("p1")?.serverUrl).toBe("https://a");
    expect(reloaded.getRegistration("p1")?.tokenSuffix).toBe("t");
    expect([...reloaded.registeredProfileIds()].sort()).toEqual(["p1", "p2"]);
    expect(reloaded.hasPrompted()).toBe(true);
  });

  it("forgets a profile's flags and records, and tolerates corrupt entries", () => {
    const storage = createMemoryPushStorage();
    const store = createPushStore(storage);
    store.setEnabled("p1", true);
    store.setRegistration("p1", {
      subscriptionId: "s1",
      expoPushToken: "t",
      tokenSuffix: "t",
      platform: "ios",
      serverUrl: "https://a",
      registeredAt: 5,
    });
    store.forgetProfile("p1");
    expect(store.isEnabled("p1")).toBe(false);
    expect(store.getRegistration("p1")).toBeNull();
    expect(storage.dump()).toEqual({});

    storage.set("bb.push.registrations", JSON.stringify(["bad"]));
    storage.set("bb.push.registration.bad", "{not json");
    expect(createPushStore(storage).registeredProfileIds()).toEqual([]);
  });

  it("notifies subscribers on every write", () => {
    const store = createPushStore(createMemoryPushStorage());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.setEnabled("p1", true);
    store.markPrompted();
    unsubscribe();
    store.setEnabled("p1", false);
    expect(calls).toBe(2);
  });
});
