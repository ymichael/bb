import { describe, expect, it } from "vitest";
import {
  addServerPathForLink,
  isDeveloperRoutePath,
  matchProfileForWebLink,
  parseIncomingLink,
} from "./incoming-link";

const sawyer = { id: "p1", serverUrl: "https://sawyer.getbb.app" };
const lan = { id: "p2", serverUrl: "http://192.168.1.20:3000" };
const prefixed = { id: "p3", serverUrl: "https://home.example.com/bb" };

describe("parseIncomingLink", () => {
  it("treats the first segment of a bb:// link as a path segment, not a host", () => {
    expect(parseIncomingLink("bb://threads/thr_1?x=1#frag")).toEqual({
      kind: "scheme",
      path: "/threads/thr_1?x=1",
    });
    expect(parseIncomingLink("bb:///settings/servers/")).toEqual({
      kind: "scheme",
      path: "/settings/servers",
    });
    expect(parseIncomingLink("bb://")).toEqual({ kind: "scheme", path: "/" });
    expect(parseIncomingLink("BB://e2e/reset")).toEqual({
      kind: "scheme",
      path: "/e2e/reset",
    });
  });

  it("parses web links into origin + path + search", () => {
    expect(
      parseIncomingLink("https://sawyer.getbb.app/threads/thr_1/?view=full"),
    ).toEqual({
      kind: "web",
      origin: "https://sawyer.getbb.app",
      pathname: "/threads/thr_1",
      search: "?view=full",
    });
  });

  it("leaves dev-client and other schemes alone", () => {
    expect(
      parseIncomingLink(
        "exp+bb-app://expo-development-client/?url=http://127.0.0.1:8082",
      ),
    ).toEqual({ kind: "foreign" });
    expect(parseIncomingLink("mailto:x@y.z")).toEqual({ kind: "foreign" });
    expect(parseIncomingLink("")).toEqual({ kind: "foreign" });
  });
});

describe("matchProfileForWebLink", () => {
  it("matches by origin, ignoring scheme/port differences", () => {
    const profiles = [sawyer, lan];
    expect(
      matchProfileForWebLink(profiles, "https://sawyer.getbb.app", "/threads/x")
        ?.profile,
    ).toBe(sawyer);
    expect(
      matchProfileForWebLink(profiles, "http://sawyer.getbb.app", "/threads/x"),
    ).toBeNull();
    expect(
      matchProfileForWebLink(profiles, "http://192.168.1.20:3000", "/")
        ?.profile,
    ).toBe(lan);
    expect(
      matchProfileForWebLink(profiles, "http://192.168.1.20:3001", "/"),
    ).toBeNull();
  });

  it("strips a profile path prefix and refuses paths outside it", () => {
    const match = matchProfileForWebLink(
      [prefixed],
      "https://home.example.com",
      "/bb/threads/thr_9",
    );
    expect(match).toEqual({ profile: prefixed, pathname: "/threads/thr_9" });
    expect(
      matchProfileForWebLink([prefixed], "https://home.example.com", "/bb"),
    ).toEqual({ profile: prefixed, pathname: "/" });
    expect(
      matchProfileForWebLink(
        [prefixed],
        "https://home.example.com",
        "/bbx/threads/thr_9",
      ),
    ).toBeNull();
  });
});

describe("isDeveloperRoutePath", () => {
  it("recognises the route groups a release bundle does not ship", () => {
    expect(isDeveloperRoutePath("/dev/webview-spike")).toBe(true);
    expect(isDeveloperRoutePath("/e2e/reset?wipe=1")).toBe(true);
    expect(isDeveloperRoutePath("/webview")).toBe(false);
    expect(isDeveloperRoutePath("/development")).toBe(false);
  });
});

describe("addServerPathForLink", () => {
  it("prefills the add-server screen and remembers where to go next", () => {
    expect(
      addServerPathForLink("https://bee.getbb.app", "/webview?path=%2Fthreads"),
    ).toBe(
      "/settings/servers/add?serverUrl=https%3A%2F%2Fbee.getbb.app&next=%2Fwebview%3Fpath%3D%252Fthreads",
    );
  });

  it("omits a follow-up path that is just the root", () => {
    expect(addServerPathForLink("https://bee.getbb.app", "/")).toBe(
      "/settings/servers/add?serverUrl=https%3A%2F%2Fbee.getbb.app",
    );
  });
});
