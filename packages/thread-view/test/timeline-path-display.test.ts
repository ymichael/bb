import { describe, expect, it } from "vitest";
import {
  fileNameFromPath,
  formatTimelinePath,
} from "../src/timeline-path-display.js";

describe("formatTimelinePath", () => {
  it("uses full paths for text surfaces and compact names for app labels", () => {
    expect(
      formatTimelinePath({
        path: "$BB_DEV_WORKSPACE/apps/app/src/views/appSettingsAtoms.ts",
        mode: "full",
      }),
    ).toBe("$BB_DEV_WORKSPACE/apps/app/src/views/appSettingsAtoms.ts");
    expect(
      formatTimelinePath({
        path: "$BB_DEV_WORKSPACE/apps/app/src/views/appSettingsAtoms.ts",
        mode: "compact",
      }),
    ).toBe("appSettingsAtoms.ts");
  });

  it("compacts Windows-style paths", () => {
    expect(
      formatTimelinePath({
        path: "C:\\repo\\docs\\CODE_REVIEW.md",
        mode: "compact",
      }),
    ).toBe("CODE_REVIEW.md");
  });

  it("returns the last non-empty path segment for shared display labels", () => {
    expect(fileNameFromPath("/tmp/repo/src/index.ts")).toBe("index.ts");
    expect(fileNameFromPath("C:\\repo\\docs\\CODE_REVIEW.md")).toBe(
      "CODE_REVIEW.md",
    );
    expect(fileNameFromPath("/tmp/repo/")).toBe("/tmp/repo/");
  });
});
