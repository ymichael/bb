import { describe, expect, it } from "vitest";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  PATHS_EXIST_MAX_PATHS,
  hostPlatformSchema,
  pathsExistRequestSchema,
  pathsExistResponseSchema,
  statusResponseSchema,
} from "../src/index.js";

describe("hostPlatformSchema", () => {
  it("accepts the supported platform values", () => {
    for (const value of ["darwin", "linux", "wsl", "unknown"] as const) {
      expect(hostPlatformSchema.parse(value)).toBe(value);
    }
  });

  it("rejects other strings", () => {
    expect(() => hostPlatformSchema.parse("win32")).toThrow();
    expect(() => hostPlatformSchema.parse("")).toThrow();
  });
});

describe("statusResponseSchema", () => {
  it("requires platform", () => {
    expect(() =>
      statusResponseSchema.parse({
        hostId: "host_1",
        connected: true,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
      }),
    ).toThrow();
  });

  it("accepts a fully formed status", () => {
    expect(
      statusResponseSchema.parse({
        hostId: "host_1",
        connected: true,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: true,
        platform: "darwin",
      }),
    ).toMatchObject({ platform: "darwin" });
  });
});

describe("pathsExistRequestSchema", () => {
  it("dedupes repeated paths", () => {
    const result = pathsExistRequestSchema.parse({
      paths: ["/a", "/a", "/b"],
    });
    expect(result.paths).toEqual(["/a", "/b"]);
  });

  it("rejects empty path arrays", () => {
    expect(() => pathsExistRequestSchema.parse({ paths: [] })).toThrow();
  });

  it("rejects empty-string path entries", () => {
    expect(() => pathsExistRequestSchema.parse({ paths: [""] })).toThrow();
  });

  it("rejects oversized batches", () => {
    const oversized = Array.from(
      { length: PATHS_EXIST_MAX_PATHS + 1 },
      (_, i) => `/p${i}`,
    );
    expect(() => pathsExistRequestSchema.parse({ paths: oversized })).toThrow();
  });
});

describe("pathsExistResponseSchema", () => {
  it("requires existence to be a boolean record", () => {
    expect(
      pathsExistResponseSchema.parse({
        existence: { "/a": true, "/b": false },
      }),
    ).toEqual({ existence: { "/a": true, "/b": false } });
  });

  it("rejects non-boolean values", () => {
    expect(() =>
      pathsExistResponseSchema.parse({ existence: { "/a": "yes" } }),
    ).toThrow();
  });
});
