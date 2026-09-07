import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const scan = scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), {
  allow: [/^(?:\.\.\/)+vitest\.shared\.js$/u],
});

describe("echo-provider imports only the public SDK", () => {
  it("scans the plugin's source files", () => {
    expect(scan.files).toContain("server.ts");
    expect(scan.files).toContain("host.ts");
    expect(scan.files).toContain(join("src", "provider-bridge.ts"));
  });

  it("has no @bb/* import and stays inside the allowlist", () => {
    expect(scan.violations).toEqual([]);
  });

  it("declares no @bb/* dependency in package.json", () => {
    expect(scan.privateDependencies).toEqual([]);
  });
});
