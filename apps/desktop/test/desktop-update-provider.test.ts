import { describe, expect, it } from "vitest";
import {
  createDesktopUpdateFeedUrl,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";

describe("desktop update feed url", () => {
  it("gives each platform its own feed file inside one release tag", () => {
    expect(createDesktopUpdateFeedUrl("macos")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version.json",
    );
    expect(createDesktopUpdateFeedUrl("linux")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version-linux.json",
    );
  });
});

const APP_IMAGE_PATH = "/home/user/Apps/bb-0.37.0-x86_64.AppImage";
const alwaysReplaceable = () => true;
const neverReplaceable = () => false;

describe("desktop update support", () => {
  it("enables both update paths on macOS", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: neverReplaceable,
        env: {},
        platform: "macos",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("installs updates on Linux only inside an AppImage", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: {},
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: "  " },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
  });

  it("refuses to install into an AppImage it cannot replace", () => {
    const checked: Array<string> = [];

    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: (path) => {
          checked.push(path);
          return false;
        },
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(checked).toEqual([APP_IMAGE_PATH]);
  });

  it("does not consult the filesystem on macOS", () => {
    let consulted = false;

    resolveDesktopUpdateSupport({
      canReplaceAppImage: () => {
        consulted = true;
        return true;
      },
      env: { APPIMAGE: APP_IMAGE_PATH },
      platform: "macos",
    });

    expect(consulted).toBe(false);
  });
});
