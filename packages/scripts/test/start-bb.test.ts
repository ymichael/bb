import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshStartBb(): Promise<
  typeof import("../src/commands/start-bb.js")
> {
  vi.resetModules();
  return import("../src/commands/start-bb.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("start-bb", () => {
  it("uses production defaults when NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_APP_URL", undefined);
    const { resolveStartBbContext } = await importFreshStartBb();

    const context = resolveStartBbContext();

    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
    expect(context.daemonPort).toBe(38887);
    expect(context.dataDir).toBe(path.join(os.homedir(), ".bb"));
    expect(context.sharedEnv.NODE_ENV).toBe("production");
    expect(context.sharedEnv.BB_APP_URL).toBeUndefined();
  });

  it("uses development defaults consistently when NODE_ENV=development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_APP_URL", undefined);
    const { resolveStartBbContext } = await importFreshStartBb();

    const context = resolveStartBbContext();

    expect(context.serverUrl).toBe("http://127.0.0.1:3334");
    expect(context.daemonPort).toBe(3002);
    expect(context.dataDir).toBe(path.join(os.homedir(), ".bb-dev"));
    expect(context.sharedEnv.NODE_ENV).toBe("development");
    expect(context.sharedEnv.BB_APP_URL).toBeUndefined();
  });

  it("lets explicit BB_* overrides win", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/custom-data");
    vi.stubEnv("BB_SERVER_PORT", "4444");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "5555");
    const { resolveStartBbContext } = await importFreshStartBb();

    const context = resolveStartBbContext();

    expect(context.serverUrl).toBe("http://127.0.0.1:4444");
    expect(context.daemonPort).toBe(5555);
    expect(context.dataDir).toBe(path.join(os.homedir(), "custom-data"));
  });
});
