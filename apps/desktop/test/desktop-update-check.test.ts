import { describe, expect, it, vi } from "vitest";
import type { BbDesktopVersionFeed } from "@bb/desktop-contract";
import {
  createDesktopUpdateService,
  DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS,
  DESKTOP_UPDATE_CHECK_TIMEOUT_MS,
  parseDesktopVersionFeed,
} from "../src/desktop-update-check.js";

const checkedAt = "2026-05-21T00:00:00.000Z";

function createFeed(version: string): BbDesktopVersionFeed {
  return {
    channel: "latest",
    files: [
      {
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        size: 123456789,
        url: `bb-${version}-universal.zip`,
      },
    ],
    minimumSystemVersion: null,
    path: `bb-${version}-universal.zip`,
    platform: "macos",
    releaseDate: checkedAt,
    releaseName: `bb desktop ${version}`,
    releaseNotes: null,
    schemaVersion: 1,
    sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
    stagingPercentage: null,
    version,
  };
}

function createFeedResponse(version: string): Response {
  return new Response(JSON.stringify(createFeed(version)), {
    headers: { "content-type": "application/json" },
  });
}

describe("desktop update feed parsing", () => {
  it("accepts a valid desktop-version.json payload", () => {
    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.1",
      payloadText: JSON.stringify(createFeed("0.0.2")),
      platform: "macos",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") {
      throw new Error(result.reason);
    }
    expect(result.info).toEqual({
      lastCheckedAt: checkedAt,
      latestVersion: "0.0.2",
      pendingVersion: null,
      platform: "macos",
      updateAvailable: true,
      updateDownloaded: false,
      version: "0.0.1",
    });
  });

  it("rejects a payload with a missing required field", () => {
    const payload = {
      channel: "latest",
      files: [
        {
          sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
          size: 123456789,
          url: "bb-0.0.2-universal.zip",
        },
      ],
      minimumSystemVersion: null,
      path: "bb-0.0.2-universal.zip",
      platform: "macos",
      releaseDate: checkedAt,
      releaseName: "bb desktop 0.0.2",
      releaseNotes: null,
      schemaVersion: 1,
      sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
      stagingPercentage: null,
    };

    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.1",
      payloadText: JSON.stringify(payload),
      platform: "macos",
    });

    expect(result.kind).toBe("malformed");
  });

  it("rejects malformed JSON", () => {
    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.1",
      payloadText: "{",
      platform: "macos",
    });

    expect(result.kind).toBe("malformed");
  });

  it("rejects a feed that describes another platform", () => {
    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.1",
      payloadText: JSON.stringify({
        ...createFeed("0.0.2"),
        platform: "linux",
      }),
      platform: "macos",
    });

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") {
      throw new Error("Expected a cross-platform feed to be rejected");
    }
    expect(result.reason).toContain("another platform");
  });

  it("rejects a feed that describes another channel", () => {
    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.1",
      payloadText: JSON.stringify({
        ...createFeed("0.0.2"),
        channel: "nightly",
      }),
      platform: "macos",
    });

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") {
      throw new Error("Expected a cross-channel feed to be rejected");
    }
    expect(result.reason).toContain("another channel");
  });

  it("accepts a Linux feed on a Linux build", () => {
    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.1",
      payloadText: JSON.stringify({
        ...createFeed("0.0.2"),
        platform: "linux",
      }),
      platform: "linux",
    });

    expect(result.kind).toBe("valid");
  });

  it("does not mark a lower feed version as an available update", () => {
    const result = parseDesktopVersionFeed({
      channel: "latest",
      checkedAt,
      currentVersion: "0.0.2",
      payloadText: JSON.stringify(createFeed("0.0.1")),
      platform: "macos",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") {
      throw new Error(result.reason);
    }
    expect(result.info).toEqual({
      lastCheckedAt: checkedAt,
      latestVersion: "0.0.1",
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.2",
    });
  });
});

describe("desktop update service", () => {
  it("preserves prior version state after a transient network failure", async () => {
    let fetchCount = 0;
    let nowMs = Date.parse(checkedAt);
    const failedCheckedAt = "2026-05-21T00:01:00.000Z";
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return createFeedResponse("0.0.2");
      }
      throw new Error("network offline");
    };
    const service = createDesktopUpdateService({
      channel: "latest",
      currentVersion: "0.0.1",
      enabled: true,
      feedUrl: "https://example.test/desktop-version.json",
      fetchImpl,
      logger: { warn() {} },
      now: () => nowMs,
      platform: "macos",
    });

    const successfulInfo = await service.checkForUpdates();
    expect(successfulInfo).toEqual({
      lastCheckedAt: checkedAt,
      latestVersion: "0.0.2",
      pendingVersion: null,
      platform: "macos",
      updateAvailable: true,
      updateDownloaded: false,
      version: "0.0.1",
    });

    nowMs = Date.parse(failedCheckedAt);
    const failedInfo = await service.checkForUpdates();

    expect(fetchCount).toBe(2);
    expect(failedInfo).toEqual({
      lastCheckedAt: failedCheckedAt,
      latestVersion: "0.0.2",
      pendingVersion: null,
      platform: "macos",
      updateAvailable: true,
      updateDownloaded: false,
      version: "0.0.1",
    });
  });

  it("preserves prior version state after a timeout failure", async () => {
    vi.useFakeTimers();
    try {
      let fetchCount = 0;
      let nowMs = Date.parse(checkedAt);
      const timeoutCheckedAt = "2026-05-21T00:02:00.000Z";
      const fetchImpl: typeof fetch = async (_input, init) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return createFeedResponse("0.0.2");
        }
        const signal = init?.signal;
        if (!signal) {
          throw new Error("timeout test expected an abort signal");
        }
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("timeout aborted")),
            { once: true },
          );
        });
      };
      const service = createDesktopUpdateService({
        channel: "latest",
        currentVersion: "0.0.1",
        enabled: true,
        feedUrl: "https://example.test/desktop-version.json",
        fetchImpl,
        logger: { warn() {} },
        now: () => nowMs,
        platform: "macos",
      });

      await service.checkForUpdates();
      nowMs = Date.parse(timeoutCheckedAt);
      const timeoutInfoPromise = service.checkForUpdates();
      await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_CHECK_TIMEOUT_MS);
      const timeoutInfo = await timeoutInfoPromise;

      expect(fetchCount).toBe(2);
      expect(timeoutInfo).toEqual({
        lastCheckedAt: timeoutCheckedAt,
        latestVersion: "0.0.2",
        pendingVersion: null,
        platform: "macos",
        updateAvailable: true,
        updateDownloaded: false,
        version: "0.0.1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles rapid active-trigger checks", async () => {
    let fetchCount = 0;
    let nowMs = Date.parse(checkedAt);
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return createFeedResponse("0.0.2");
    };
    const service = createDesktopUpdateService({
      channel: "latest",
      currentVersion: "0.0.1",
      enabled: true,
      feedUrl: "https://example.test/desktop-version.json",
      fetchImpl,
      logger: { warn() {} },
      now: () => nowMs,
      platform: "macos",
    });

    const firstInfo = await service.checkAfterActive();
    if (firstInfo === null) {
      throw new Error("enabled active check returned null");
    }
    nowMs += 1_000;
    const throttledInfo = await service.checkAfterActive();

    expect(fetchCount).toBe(1);
    expect(throttledInfo).toEqual(firstInfo);

    nowMs = Date.parse(checkedAt) + DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS;
    await service.checkAfterActive();

    expect(fetchCount).toBe(2);
  });

  it("reports the injected linux platform in its base info", () => {
    const service = createDesktopUpdateService({
      channel: "latest",
      currentVersion: "0.0.1",
      enabled: false,
      feedUrl: "https://example.test/desktop-version.json",
      platform: "linux",
    });

    expect(service.getInfo().platform).toBe("linux");
  });
});
