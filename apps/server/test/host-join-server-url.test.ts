import { describe, expect, it } from "vitest";
import { resolveHostJoinServerUrl } from "../src/services/hosts/host-join-server-url.js";

describe("host join server URL resolution", () => {
  it("uses a local server URL for loopback local join requests", () => {
    expect(
      resolveHostJoinServerUrl({
        appUrl: undefined,
        isLocalJoin: true,
        remoteAddress: "::ffff:127.0.0.1",
        serverPort: 3334,
      }),
    ).toBe("http://127.0.0.1:3334");
  });

  it("uses the local server URL over configured BB_APP_URL for loopback local join requests", () => {
    expect(
      resolveHostJoinServerUrl({
        appUrl: "https://stale.example.test",
        isLocalJoin: true,
        remoteAddress: "127.0.0.1",
        serverPort: 3334,
      }),
    ).toBe("http://127.0.0.1:3334");
  });

  it("rejects non-loopback local join requests without BB_APP_URL", () => {
    expect(() =>
      resolveHostJoinServerUrl({
        appUrl: undefined,
        isLocalJoin: true,
        remoteAddress: "192.168.1.50",
        serverPort: 3334,
      }),
    ).toThrow("BB_APP_URL is not configured");
  });

  it("uses BB_APP_URL for non-loopback local join requests when configured", () => {
    expect(
      resolveHostJoinServerUrl({
        appUrl: "https://bb.example.test",
        isLocalJoin: true,
        remoteAddress: "192.168.1.50",
        serverPort: 3334,
      }),
    ).toBe("https://bb.example.test");
  });
});
