import { describe, expect, it } from "vitest";
import { buildDaemonRestartCommand } from "../src/shared.js";

describe("standalone restart command", () => {
  it("reloads the env file without embedding provider secrets", () => {
    const command = buildDaemonRestartCommand({
      daemonPid: 123,
      daemonPort: 456,
      dataDir: "/tmp/bb root",
      entrypoint: "/repo/apps/host-daemon/dist/index.js",
      envFilePath: "/repo/.env",
      logPath: "/tmp/bb logs/host-daemon.log",
      parentPid: 789,
      serverUrl: "http://127.0.0.1:3334",
    });

    expect(command).toContain("(kill '123' >/dev/null 2>&1 || true)");
    expect(command).toContain("[ ! -f '/repo/.env' ] || . '/repo/.env'");
    expect(command).toContain("BB_DATA_DIR='/tmp/bb root'");
    expect(command).toContain("exec node '/repo/apps/host-daemon/dist/index.js'");
    expect(command).toContain(">> '/tmp/bb logs/host-daemon.log' 2>&1) &");
    expect(command).not.toContain("OPENAI_API_KEY");
    expect(command).not.toContain("ANTHROPIC_API_KEY");
  });

  it("uses a no-op env loader when no env file exists", () => {
    const command = buildDaemonRestartCommand({
      daemonPid: null,
      daemonPort: 456,
      dataDir: "/tmp/bb-root",
      entrypoint: "/repo/apps/host-daemon/dist/index.js",
      envFilePath: null,
      logPath: "/tmp/host-daemon.log",
      parentPid: 789,
      serverUrl: "http://127.0.0.1:3334",
    });

    expect(command).toContain("(set -a; :; set +a;");
    expect(command).not.toContain("kill");
  });
});
