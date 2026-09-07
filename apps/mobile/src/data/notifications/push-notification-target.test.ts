import { describe, expect, it, vi } from "vitest";
import {
  parsePushNotificationData,
  resolvePushTargetProfile,
} from "./push-notification-target";

const sawyer = { id: "p1", serverUrl: "https://sawyer.getbb.app" };
const lan = { id: "p2", serverUrl: "http://192.168.1.20:3000" };

describe("parsePushNotificationData", () => {
  it("reads the thread id and optional project / server hints", () => {
    expect(
      parsePushNotificationData({ threadId: "thr_1", projectId: "prj_1" }),
    ).toEqual({ threadId: "thr_1", projectId: "prj_1", serverUrl: null });
    expect(
      parsePushNotificationData({
        threadId: "thr_1",
        url: "https://sawyer.getbb.app/threads/thr_1",
        extra: 1,
      }),
    ).toEqual({
      threadId: "thr_1",
      projectId: null,
      serverUrl: "https://sawyer.getbb.app",
    });
    expect(
      parsePushNotificationData({
        threadId: "thr_1",
        serverUrl: "https://home.example.com/bb/",
      }),
    ).toEqual({
      threadId: "thr_1",
      projectId: null,
      serverUrl: "https://home.example.com/bb",
    });
  });

  it("rejects payloads without a thread id", () => {
    expect(parsePushNotificationData({ projectId: "p" })).toBeNull();
    expect(parsePushNotificationData("nope")).toBeNull();
    expect(parsePushNotificationData(undefined)).toBeNull();
  });
});

describe("resolvePushTargetProfile", () => {
  const target = { threadId: "thr_1", projectId: null, serverUrl: null };

  it("uses the server hint when it names a saved profile", async () => {
    const hasThread = vi.fn(async () => false);
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "http://192.168.1.20:3000" },
        { profiles: [sawyer, lan], activeProfileId: "p1", hasThread },
      ),
    ).toBe(lan);
    expect(hasThread).not.toHaveBeenCalled();
  });

  it("matches a server hint with a saved path prefix", async () => {
    const prefixed = {
      id: "p3",
      serverUrl: "https://home.example.com/bb",
    };
    const hasThread = vi.fn(async () => false);
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://home.example.com/bb" },
        { profiles: [sawyer, prefixed], activeProfileId: "p1", hasThread },
      ),
    ).toBe(prefixed);
    expect(hasThread).not.toHaveBeenCalled();
  });

  it("probes the only profile when no server hint matches", async () => {
    const hasThread = vi.fn(async () => true);
    expect(
      await resolvePushTargetProfile(target, {
        profiles: [sawyer],
        activeProfileId: null,
        hasThread,
      }),
    ).toBe(sawyer);
    expect(hasThread).toHaveBeenCalledWith(sawyer.serverUrl, "thr_1");
  });

  it("probes profiles when a server hint does not match", async () => {
    const hasThread = vi.fn(
      async (serverUrl: string) => serverUrl === lan.serverUrl,
    );
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://unknown.example" },
        { profiles: [sawyer, lan], activeProfileId: "p1", hasThread },
      ),
    ).toBe(lan);
    expect(hasThread).toHaveBeenCalledTimes(2);
  });

  it("probes the active profile first, then the others, tolerating failures", async () => {
    const hasThread = vi.fn(async (serverUrl: string) => {
      if (serverUrl === lan.serverUrl) throw new Error("offline");
      return serverUrl === sawyer.serverUrl;
    });
    expect(
      await resolvePushTargetProfile(target, {
        profiles: [sawyer, lan],
        activeProfileId: "p2",
        hasThread,
      }),
    ).toBe(sawyer);
    expect(hasThread.mock.calls.map(([url]) => url)).toEqual([
      lan.serverUrl,
      sawyer.serverUrl,
    ]);
  });

  it("gives up when no server has the thread", async () => {
    expect(
      await resolvePushTargetProfile(target, {
        profiles: [sawyer, lan],
        activeProfileId: "p1",
        hasThread: async () => false,
      }),
    ).toBeNull();
  });
});
