import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  expandHomeDirectory,
  resolveBbPath,
  resolveBbRoot,
} from "../src/storage-paths.js";

const originalHome = process.env.HOME;
const originalBbRoot = process.env.BB_ROOT;

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.BB_ROOT = originalBbRoot;
});

describe("storage paths", () => {
  it("defaults to ~/.bb when BB_ROOT is unset", () => {
    process.env.HOME = "/Users/tester";
    delete process.env.BB_ROOT;

    expect(resolveBbRoot(process.env)).toBe("/Users/tester/.bb");
    expect(resolveBbPath(process.env, "logs", "daemon.log")).toBe(
      "/Users/tester/.bb/logs/daemon.log",
    );
  });

  it("uses an explicit BB_ROOT when configured", () => {
    process.env.BB_ROOT = "/tmp/bb-root";

    expect(resolveBbRoot(process.env)).toBe("/tmp/bb-root");
    expect(resolveBbPath(process.env, "environment-agents")).toBe(
      "/tmp/bb-root/environment-agents",
    );
  });

  it("expands home-relative BB_ROOT values", () => {
    process.env.HOME = "/Users/tester";
    process.env.BB_ROOT = "~/sandbox/bb";

    expect(expandHomeDirectory(process.env.BB_ROOT)).toBe(
      "/Users/tester/sandbox/bb",
    );
    expect(resolveBbRoot(process.env)).toBe(
      resolve("/Users/tester/sandbox/bb"),
    );
  });
});
