import { describe, expect, it } from "vitest";
import { createPackagedAppLaunchArguments } from "../scripts/packaged-app-launch.mjs";

describe("createPackagedAppLaunchArguments", () => {
  it("disables the Chromium sandbox on Linux", () => {
    expect(
      createPackagedAppLaunchArguments({
        platform: "linux",
        userDataDir: "/tmp/smoke/user-data",
      }),
    ).toEqual(["--no-sandbox", "--user-data-dir=/tmp/smoke/user-data"]);
  });

  it("keeps the Chromium sandbox on macOS", () => {
    expect(
      createPackagedAppLaunchArguments({
        platform: "darwin",
        userDataDir: "/tmp/smoke/user-data",
      }),
    ).toEqual(["--user-data-dir=/tmp/smoke/user-data"]);
  });
});
