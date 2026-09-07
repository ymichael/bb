import { describe, expect, it } from "vitest";
import {
  desktopBrowserCommandSchema,
  desktopBrowserResultSchemas,
} from "../src/desktop-browser.js";

const scope = {
  instanceId: "window",
  generation: "generation",
  threadId: "thread",
};
describe("desktop browser command boundaries", () => {
  it("rejects arbitrary RPC, endpoints, unsupported navigation schemes, and duplicate grants", () => {
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.rpc",
        method: "Runtime.evaluate",
      }).success,
    ).toBe(false);
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.open_connection",
        ...scope,
        leaseId: "lease",
        tabIds: ["tab"],
        endpoint: "http://internal",
      }).success,
    ).toBe(false);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,test",
      "https://user:password@example.com",
    ]) {
      expect(
        desktopBrowserCommandSchema.safeParse({
          type: "desktop.browser.create_tab",
          ...scope,
          tabId: "tab",
          url,
          profile: { kind: "personal" },
          presentation: "hidden",
        }).success,
      ).toBe(false);
    }
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.acquire_control",
        ...scope,
        leaseId: "lease",
        controllerLabel: "Agent",
        expiresAt: Date.now() + 1000,
        tabIds: ["tab", "tab"],
      }).success,
    ).toBe(false);
  });

  it("requires explicit thread, generation, and scoped local connection results", () => {
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.list_tabs",
        instanceId: "window",
      }).success,
    ).toBe(false);
    for (const wsEndpoint of [
      "ws://example.com:1234/",
      "http://127.0.0.1:1234/",
      "ws://user:pass@127.0.0.1:1234/",
    ]) {
      expect(
        desktopBrowserResultSchemas[
          "desktop.browser.open_connection"
        ].safeParse({ wsEndpoint, expiresAt: Date.now() + 1000 }).success,
      ).toBe(false);
    }
    expect(
      desktopBrowserResultSchemas["desktop.browser.open_connection"].safeParse({
        wsEndpoint: "ws://127.0.0.1:1234/scoped/credential",
        expiresAt: Date.now() + 1000,
      }).success,
    ).toBe(true);
  });
});
