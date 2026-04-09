import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStartHostDaemonContext } from "../src/commands/start-host-daemon.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("start-host-daemon", () => {
  it("uses production defaults when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");

    const context = resolveStartHostDaemonContext();

    expect(context.serverUrl).toBe("http://localhost:3000");
    expect(context.daemonPort).toBe(3001);
    expect(context.dataDir).toBe(path.join(os.homedir(), ".bb"));
  });

  it("lets explicit BB_* overrides win", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/host-daemon-data");
    vi.stubEnv("BB_SERVER_URL", "https://server.example.test");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "4445");

    const context = resolveStartHostDaemonContext();

    expect(context.serverUrl).toBe("https://server.example.test");
    expect(context.daemonPort).toBe(4445);
    expect(context.dataDir).toBe(path.join(os.homedir(), "host-daemon-data"));
  });
});
