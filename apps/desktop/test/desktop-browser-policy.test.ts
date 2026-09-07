import { describe, expect, it } from "vitest";
import { bbDesktopBrowserAttachRequestSchema } from "@bb/desktop-contract";
import {
  evaluatePopupRate,
  isAllowedBrowserUrl,
} from "../src/desktop-browser-policy.js";

describe("isAllowedBrowserUrl", () => {
  it("allows http, https, and exact about:blank", () => {
    expect(isAllowedBrowserUrl("https://example.com")).toBe(true);
    expect(isAllowedBrowserUrl("http://example.com/path?q=1")).toBe(true);
    expect(isAllowedBrowserUrl("about:blank")).toBe(true);
  });

  it("blocks unsupported schemes and unparseable URLs", () => {
    expect(isAllowedBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedBrowserUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isAllowedBrowserUrl("about:config")).toBe(false);
    expect(isAllowedBrowserUrl("about:blank#fragment")).toBe(false);
    expect(isAllowedBrowserUrl("about:blank?query")).toBe(false);
    expect(isAllowedBrowserUrl(" about:blank")).toBe(false);
    expect(isAllowedBrowserUrl("not a url")).toBe(false);
    expect(isAllowedBrowserUrl("")).toBe(false);
  });
});

describe("browser IPC payload schemas", () => {
  it("rejects legacy layout fields in attach requests", () => {
    expect(
      bbDesktopBrowserAttachRequestSchema.safeParse({
        threadId: "thread-1",
        tabId: "browser:abc",
        url: "",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        layout: { left: 0, top: 0, rightInset: 0, bottomInset: 0 },
        visible: false,
      }).success,
    ).toBe(false);
  });
});

describe("evaluatePopupRate", () => {
  const args = { windowMs: 10_000, maxInWindow: 3 };

  it("allows popups up to the cap, then blocks within the window", () => {
    let timestamps: number[] = [];
    for (const now of [0, 100, 200]) {
      const decision = evaluatePopupRate({ ...args, timestamps, now });
      expect(decision.allowed).toBe(true);
      timestamps = decision.timestamps;
    }
    const blocked = evaluatePopupRate({ ...args, timestamps, now: 300 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.timestamps).toHaveLength(3);
  });

  it("allows again once old timestamps age out of the window", () => {
    const timestamps = [0, 100, 200];
    const decision = evaluatePopupRate({ ...args, timestamps, now: 11_000 });
    expect(decision.allowed).toBe(true);
    expect(decision.timestamps).toEqual([11_000]);
  });
});
