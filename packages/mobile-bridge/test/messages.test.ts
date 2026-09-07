import { describe, expect, it } from "vitest";
import {
  parsePageToShellMessage,
  parseNativeShellHandshake,
  type NativeShellHandshake,
} from "../src/index.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

const handshake: NativeShellHandshake = {
  bridgeVersion: 2,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: [
    "haptic",
    "badge",
    "share",
    "open-external",
    "safe-area",
    "open-native",
  ],
};

describe("parsePageToShellMessage", () => {
  it("accepts every message kind the contract defines", () => {
    const cases: unknown[] = [
      { type: "ready", path: "/threads/thr_1" },
      { type: "title", title: "bb", path: "/" },
      { type: "haptic", kind: "impact-medium" },
      { type: "badge", count: 0 },
      { type: "open-external", url: "https://example.com/docs" },
      { type: "open-native", screen: "device-settings" },
      {
        type: "request",
        id: "r1-2",
        request: {
          kind: "share",
          payload: { url: "https://bee.getbb.app/threads/thr_1" },
        },
      },
    ];
    for (const value of cases) {
      const parsed = parsePageToShellMessage(json(value));
      expect(parsed.ok, JSON.stringify(value)).toBe(true);
    }
  });

  it("rejects a payload that is not a JSON string", () => {
    expect(parsePageToShellMessage({ type: "ready", path: "/" })).toEqual({
      ok: false,
      reason: "message was not a string",
    });
    expect(parsePageToShellMessage("not json").ok).toBe(false);
  });

  it("drops a message type an older shell does not know", () => {
    const parsed = parsePageToShellMessage(
      json({ type: "open-camera", lens: "front" }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses a native screen the shell does not own", () => {
    expect(
      parsePageToShellMessage(
        json({ type: "open-native", screen: "/settings/servers" }),
      ).ok,
    ).toBe(false);
    expect(
      parsePageToShellMessage(json({ type: "open-native", screen: "" })).ok,
    ).toBe(false);
  });

  it("rejects extra fields so a typo never travels silently", () => {
    const parsed = parsePageToShellMessage(
      json({ type: "badge", count: 3, colour: "red" }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a badge count that is negative or fractional", () => {
    expect(parsePageToShellMessage(json({ type: "badge", count: -1 })).ok).toBe(
      false,
    );
    expect(
      parsePageToShellMessage(json({ type: "badge", count: 1.5 })).ok,
    ).toBe(false);
  });

  it("refuses any external link that is not http or https", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "bb://settings",
      "not a url",
    ]) {
      expect(
        parsePageToShellMessage(json({ type: "open-external", url })).ok,
        url,
      ).toBe(false);
    }
    expect(
      parsePageToShellMessage(
        json({ type: "open-external", url: "https://example.com/docs" }),
      ).ok,
    ).toBe(true);
  });

  it("applies the same rule to a share url", () => {
    expect(
      parsePageToShellMessage(
        json({
          type: "request",
          id: "r1",
          request: { kind: "share", payload: { url: "javascript:alert(1)" } },
        }),
      ).ok,
    ).toBe(false);
  });

  it("requires a share to carry text or a url", () => {
    expect(
      parsePageToShellMessage(
        json({
          type: "request",
          id: "r1",
          request: { kind: "share", payload: { title: "bb" } },
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("parseNativeShellHandshake", () => {
  it("accepts the handshake the shell injects", () => {
    expect(parseNativeShellHandshake(handshake)).toEqual(handshake);
  });

  it("reads a malformed or absent bridge as no bridge", () => {
    expect(parseNativeShellHandshake(undefined)).toBeNull();
    expect(parseNativeShellHandshake({})).toBeNull();
    expect(
      parseNativeShellHandshake({ ...handshake, safeArea: { top: 1 } }),
    ).toBeNull();
    expect(
      parseNativeShellHandshake({ ...handshake, capabilities: ["teleport"] }),
    ).toBeNull();
  });
});
