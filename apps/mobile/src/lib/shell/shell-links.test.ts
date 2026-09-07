import { describe, expect, it } from "vitest";
import {
  isNativeOnlyShellPath,
  resolveShellIncomingLink,
  shellHref,
} from "./shell-links";

const profiles = [
  { id: "p_bee", serverUrl: "https://bee.getbb.app" },
  { id: "p_lan", serverUrl: "http://10.0.0.7:38886" },
  { id: "p_prefix", serverUrl: "https://box.example.ts.net/bb" },
];

const context = {
  profiles,
  activeProfileId: "p_bee",
  developerRoutesEnabled: false,
};

describe("shellHref", () => {
  it("carries the page path and only names a profile when switching", () => {
    expect(shellHref({ profileId: null, path: "/" })).toBe("/webview");
    expect(shellHref({ profileId: null, path: "/threads/thr_1" })).toBe(
      "/webview?path=%2Fthreads%2Fthr_1",
    );
    expect(shellHref({ profileId: "p_lan", path: "/" })).toBe(
      "/webview?profileId=p_lan",
    );
  });
});

describe("isNativeOnlyShellPath", () => {
  it("keeps the screens the shell still owns", () => {
    expect(isNativeOnlyShellPath("/connect")).toBe(true);
    expect(isNativeOnlyShellPath("/connect?code=ABCD")).toBe(true);
    expect(isNativeOnlyShellPath("/settings/servers/add")).toBe(true);
    expect(isNativeOnlyShellPath("/settings")).toBe(false);
    expect(isNativeOnlyShellPath("/settings/device")).toBe(true);
    expect(isNativeOnlyShellPath("/settings/notifications")).toBe(true);
    expect(isNativeOnlyShellPath("/settings/general")).toBe(false);
    expect(isNativeOnlyShellPath("/threads/x")).toBe(false);
    expect(isNativeOnlyShellPath("/connections")).toBe(false);
  });
});

describe("resolveShellIncomingLink", () => {
  it("sends a scheme link to the page", () => {
    expect(resolveShellIncomingLink("bb://threads/thr_1", context)).toEqual({
      kind: "navigate",
      path: "/webview?path=%2Fthreads%2Fthr_1",
      profileId: null,
    });
  });

  it("keeps connect enrolment native", () => {
    expect(
      resolveShellIncomingLink("bb://connect?code=ABCD-EFGH", context),
    ).toEqual({
      kind: "navigate",
      path: "/connect?code=ABCD-EFGH",
      profileId: null,
    });
  });

  it("keeps notification settings native", () => {
    expect(
      resolveShellIncomingLink("bb://settings/notifications", context),
    ).toEqual({
      kind: "navigate",
      path: "/settings/notifications",
      profileId: null,
    });
  });

  it("hides developer routes in a release bundle", () => {
    expect(resolveShellIncomingLink("bb://dev/webview-spike", context)).toEqual(
      { kind: "navigate", path: "/", profileId: null },
    );
    expect(
      resolveShellIncomingLink("bb://dev/webview-spike", {
        ...context,
        developerRoutesEnabled: true,
      }),
    ).toEqual({
      kind: "navigate",
      path: "/dev/webview-spike",
      profileId: null,
    });
  });

  it("opens a web link on the profile that owns it", () => {
    expect(
      resolveShellIncomingLink("https://bee.getbb.app/threads/x?a=1", context),
    ).toEqual({
      kind: "navigate",
      path: "/webview?path=%2Fthreads%2Fx%3Fa%3D1",
      profileId: null,
    });
  });

  it("names the profile when a link switches servers", () => {
    const resolution = resolveShellIncomingLink(
      "http://10.0.0.7:38886/threads/x",
      context,
    );
    expect(resolution).toEqual({
      kind: "navigate",
      path: "/webview?profileId=p_lan&path=%2Fthreads%2Fx",
      profileId: "p_lan",
    });
  });

  it("strips a profile's mount prefix from the page path", () => {
    const resolution = resolveShellIncomingLink(
      "https://box.example.ts.net/bb/threads/x",
      context,
    );
    expect(resolution).toEqual({
      kind: "navigate",
      path: "/webview?profileId=p_prefix&path=%2Fthreads%2Fx",
      profileId: "p_prefix",
    });
  });

  it("offers to add a server the phone does not know", () => {
    const resolution = resolveShellIncomingLink(
      "https://other.getbb.app/threads/x",
      context,
    );
    expect(resolution.kind).toBe("unknown-server");
    if (resolution.kind !== "unknown-server") throw new Error("unreachable");
    expect(resolution.serverUrl).toBe("https://other.getbb.app");
    expect(resolution.path).toBe("/webview?path=%2Fthreads%2Fx");
  });

  it("leaves a foreign scheme alone", () => {
    expect(
      resolveShellIncomingLink("exp+bb-app://expo-development-client", context),
    ).toEqual({ kind: "passthrough" });
  });
});
