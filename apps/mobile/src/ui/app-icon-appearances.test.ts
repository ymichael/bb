import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, "..", "..");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_TYPES_WITH_ALPHA = new Set([4, 6]);

const iosIconsSchema = z.object({
  expo: z.object({
    ios: z.object({
      icon: z.object({ light: z.string(), dark: z.string() }),
    }),
  }),
});

function readIosIcons(): { light: string; dark: string } {
  const raw: unknown = JSON.parse(
    readFileSync(join(MOBILE_ROOT, "app.json"), "utf8"),
  );
  return iosIconsSchema.parse(raw).expo.ios.icon;
}

function readPngHeader(relativePath: string): {
  width: number;
  height: number;
  colorType: number;
} {
  const bytes = readFileSync(join(MOBILE_ROOT, relativePath));
  expect(bytes.subarray(0, 8), `${relativePath} is not a PNG`).toEqual(
    PNG_SIGNATURE,
  );
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

describe("iOS app icon appearances", () => {
  it("declares a dark variant so Dark Mode does not fall back to the light icon", () => {
    const { light, dark } = readIosIcons();
    expect(light).not.toBe(dark);
  });

  it("ships both variants at Apple's 1024x1024 layout size", () => {
    const { light, dark } = readIosIcons();
    for (const path of [light, dark]) {
      const { width, height } = readPngHeader(path);
      expect({ path, width, height }).toEqual({
        path,
        width: 1024,
        height: 1024,
      });
    }
  });

  it("keeps the light icon opaque and the dark icon transparent", () => {
    const { light, dark } = readIosIcons();
    expect(COLOR_TYPES_WITH_ALPHA.has(readPngHeader(light).colorType)).toBe(
      false,
    );
    expect(COLOR_TYPES_WITH_ALPHA.has(readPngHeader(dark).colorType)).toBe(
      true,
    );
  });
});
