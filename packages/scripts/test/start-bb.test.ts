import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStartBbContext } from "../src/commands/start-bb.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("start-bb", () => {
  it("uses production defaults when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");

    const context = resolveStartBbContext();

    expect(context.serverUrl).toBe("http://127.0.0.1:3000");
    expect(context.daemonPort).toBe(3001);
    expect(context.dataDir).toBe(path.join(os.homedir(), ".bb"));
    expect(context.sharedEnv.NODE_ENV).toBe("production");
  });

  it("lets explicit BB_* overrides win", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/custom-data");
    vi.stubEnv("BB_SERVER_PORT", "4444");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "5555");

    const context = resolveStartBbContext();

    expect(context.serverUrl).toBe("http://127.0.0.1:4444");
    expect(context.daemonPort).toBe(5555);
    expect(context.dataDir).toBe(path.join(os.homedir(), "custom-data"));
  });
});
