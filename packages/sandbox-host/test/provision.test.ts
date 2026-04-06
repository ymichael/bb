import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  provisionHost,
  resumeHost,
} from "../src/index.js";
import {
  SANDBOX_BB_EXECUTABLE_DIR,
  SANDBOX_BB_EXECUTABLE_PATH,
  SANDBOX_BRIDGE_DIR,
  SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
  SANDBOX_DAEMON_HEALTH_RESPONSE,
  SANDBOX_DAEMON_PATH,
  SANDBOX_DAEMON_STDERR_PATH,
  SANDBOX_DAEMON_STDOUT_PATH,
  SANDBOX_PI_PACKAGE_DIR,
  SANDBOX_PI_PACKAGE_MANIFEST_PATH,
  SANDBOX_PI_BRIDGE_PATH,
} from "../src/constants.js";

const testDaemonArtifacts = {
  bbCli: "#!/usr/bin/env node\nconsole.log('bb');\n",
  claudeCodeBridge: "console.log('claude bridge');",
  daemon: "console.log('daemon');",
  piPackageManifest: JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    piConfig: { configDir: ".pi", name: "pi" },
    version: "0.58.3",
  }),
  piBridge: "console.log('pi bridge');",
};
const testSandboxTemplate = "bb-sandbox:test-build";

const daemonStartCommand = [
  "sh -lc",
  `'rm -f ${SANDBOX_DAEMON_STDOUT_PATH} ${SANDBOX_DAEMON_STDERR_PATH}`,
  `&& node ${SANDBOX_DAEMON_PATH}`,
  `>${SANDBOX_DAEMON_STDOUT_PATH} 2>${SANDBOX_DAEMON_STDERR_PATH}'`,
].join(" ");

const sandboxCreateMock = vi.fn();
const sandboxConnectMock = vi.fn();
type MockSandboxArgs = Array<object | string | undefined>;

vi.mock("e2b", () => ({
  Sandbox: {
    create: (...args: MockSandboxArgs) => sandboxCreateMock(...args),
    connect: (...args: MockSandboxArgs) => sandboxConnectMock(...args),
  },
}));

function createMockSandbox() {
  return {
    commands: {
      run: vi.fn(),
    },
    connect: vi.fn(),
    files: {
      write: vi.fn(),
    },
    kill: vi.fn(),
    pause: vi.fn(),
    sandboxId: "sandbox-123",
    setTimeout: vi.fn(),
  };
}

const expectedProvisionDaemonEnv = {
  BB_CLI_DIR: SANDBOX_BB_EXECUTABLE_DIR,
  BB_BRIDGE_DIR: SANDBOX_BRIDGE_DIR,
  BB_DATA_DIR: "/tmp/bb-data",
  BB_HOST_ENROLL_KEY: "enroll-token",
  BB_HOST_ID: "host-123",
  BB_HOST_NAME: "sandbox-123",
  BB_HOST_TYPE: "ephemeral",
  PI_PACKAGE_DIR: SANDBOX_PI_PACKAGE_DIR,
  BB_SERVER_URL: "https://bb.example.test",
};

const expectedResumeDaemonEnv = {
  BB_CLI_DIR: SANDBOX_BB_EXECUTABLE_DIR,
  BB_BRIDGE_DIR: SANDBOX_BRIDGE_DIR,
  BB_DATA_DIR: "/tmp/bb-data",
  BB_HOST_ID: "host-123",
  BB_HOST_NAME: "sandbox-123",
  BB_HOST_TYPE: "ephemeral",
  PI_PACKAGE_DIR: SANDBOX_PI_PACKAGE_DIR,
  BB_SERVER_URL: "https://bb.example.test",
};

describe("sandbox host provisioning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("creates a sandbox with daemon envs and lifecycle pause", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxCreateMock.mockResolvedValue(sandbox);

    const host = await provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test/",
      template: "custom-template",
      timeoutMs: 123_000,
    });

    expect(sandboxCreateMock).toHaveBeenCalledWith("custom-template", {
      envs: {
        BB_CLI_DIR: SANDBOX_BB_EXECUTABLE_DIR,
        BB_BRIDGE_DIR: SANDBOX_BRIDGE_DIR,
        BB_DATA_DIR: "/tmp/bb-data",
        BB_HOST_ENROLL_KEY: "enroll-token",
        BB_HOST_ID: "host-123",
        BB_HOST_NAME: "sandbox-123",
        BB_HOST_TYPE: "ephemeral",
        PI_PACKAGE_DIR: SANDBOX_PI_PACKAGE_DIR,
        BB_SERVER_URL: "https://bb.example.test",
      },
      lifecycle: { onTimeout: "pause" },
      timeoutMs: 123_000,
    });
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      1,
      SANDBOX_BB_EXECUTABLE_PATH,
      testDaemonArtifacts.bbCli,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      2,
      SANDBOX_DAEMON_PATH,
      testDaemonArtifacts.daemon,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      3,
      SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
      testDaemonArtifacts.claudeCodeBridge,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      4,
      SANDBOX_PI_BRIDGE_PATH,
      testDaemonArtifacts.piBridge,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      5,
      SANDBOX_PI_PACKAGE_MANIFEST_PATH,
      testDaemonArtifacts.piPackageManifest,
      {},
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      `chmod +x ${SANDBOX_BB_EXECUTABLE_PATH}`,
      {},
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(daemonStartCommand, {
      background: true,
      envs: expectedProvisionDaemonEnv,
    });
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "curl -sf http://127.0.0.1:9111/health",
      {},
    );
    expect(host.hostId).toBe("host-123");
    expect(host.externalId).toBe("sandbox-123");
  });

  it("retries the daemon health check until it succeeds", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("still not ready"))
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxCreateMock.mockResolvedValue(sandbox);

    const provisioning = provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      template: testSandboxTemplate,
    });

    await vi.runAllTimersAsync();
    await provisioning;

    expect(sandbox.commands.run).toHaveBeenCalledTimes(5);
  });

  it("retries sandbox creation up to three attempts", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxCreateMock
      .mockRejectedValueOnce(new Error("create failed"))
      .mockRejectedValueOnce(new Error("create failed again"))
      .mockResolvedValueOnce(sandbox);

    const provisioning = provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      template: testSandboxTemplate,
    });

    await vi.runAllTimersAsync();
    await provisioning;

    expect(sandboxCreateMock).toHaveBeenCalledTimes(3);
  });

  it("destroys the sandbox if daemon startup fails", async () => {
    const sandbox = createMockSandbox();
    sandbox.files.write.mockRejectedValueOnce(new Error("write failed"));
    sandboxCreateMock.mockResolvedValue(sandbox);

    await expect(
      provisionHost({
        daemonArtifacts: testDaemonArtifacts,
        daemonEnv: {},
        enrollKey: "enroll-token",
        hostId: "host-123",
        hostName: "sandbox-123",
        serverUrl: "https://bb.example.test",
        template: testSandboxTemplate,
      }),
    ).rejects.toThrow("write failed");

    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("destroys the sandbox if daemon health never becomes ready", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockRejectedValue(new Error("health failed"));
    sandboxCreateMock.mockResolvedValue(sandbox);

    const provisioning = provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      template: testSandboxTemplate,
    });
    const assertion = expect(provisioning).rejects.toThrow("health failed");

    await vi.runAllTimersAsync();
    await assertion;
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("suspends and destroys the sandbox through the lifecycle wrapper", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxCreateMock.mockResolvedValue(sandbox);

    const host = await provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      template: testSandboxTemplate,
    });

    await host.suspend();
    await host.destroy();

    expect(sandbox.pause).toHaveBeenCalledTimes(1);
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("resumes an existing sandbox and restarts the daemon when health check fails", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockRejectedValueOnce(new Error("daemon not running"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 654 })
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxConnectMock.mockResolvedValue(sandbox);

    const resuming = resumeHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      externalId: "sandbox-123",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      timeoutMs: 45_000,
    });

    await vi.runAllTimersAsync();
    const host = await resuming;

    expect(sandboxConnectMock).toHaveBeenCalledWith("sandbox-123", {
      timeoutMs: 45_000,
    });
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      1,
      SANDBOX_BB_EXECUTABLE_PATH,
      testDaemonArtifacts.bbCli,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      2,
      SANDBOX_DAEMON_PATH,
      testDaemonArtifacts.daemon,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      3,
      SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
      testDaemonArtifacts.claudeCodeBridge,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      4,
      SANDBOX_PI_BRIDGE_PATH,
      testDaemonArtifacts.piBridge,
      {},
    );
    expect(sandbox.files.write).toHaveBeenNthCalledWith(
      5,
      SANDBOX_PI_PACKAGE_MANIFEST_PATH,
      testDaemonArtifacts.piPackageManifest,
      {},
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      `chmod +x ${SANDBOX_BB_EXECUTABLE_PATH}`,
      {},
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith("curl -sf http://127.0.0.1:9111/health", {});
    expect(sandbox.commands.run).toHaveBeenCalledWith(daemonStartCommand, {
      background: true,
      envs: expectedResumeDaemonEnv,
    });
    expect(host.externalId).toBe("sandbox-123");
  });

  it("resumes an existing sandbox without rewriting bundles when the daemon is already healthy", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run.mockResolvedValueOnce({
      stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n`,
    });
    sandboxConnectMock.mockResolvedValue(sandbox);

    const host = await resumeHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      externalId: "sandbox-123",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
    });

    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(sandbox.commands.run).toHaveBeenCalledWith("curl -sf http://127.0.0.1:9111/health", {});
    expect(sandbox.files.write).not.toHaveBeenCalled();
    expect(host.externalId).toBe("sandbox-123");
  });

  it("destroys the resumed sandbox if daemon restart never becomes healthy", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockRejectedValueOnce(new Error("daemon not running"))
      .mockResolvedValueOnce({ pid: 654 })
      .mockRejectedValue(new Error("health failed after restart"));
    sandboxConnectMock.mockResolvedValue(sandbox);

    const resuming = resumeHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      externalId: "sandbox-123",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
    });
    const assertion = expect(resuming).rejects.toThrow("health failed after restart");

    await vi.runAllTimersAsync();
    await assertion;

    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("includes custom daemon env values during provisioning", async () => {
    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxCreateMock.mockResolvedValue(sandbox);

    await provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: { GITHUB_TOKEN: "github-token" },
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      template: testSandboxTemplate,
    });

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      testSandboxTemplate,
      expect.objectContaining({
        envs: {
          BB_CLI_DIR: SANDBOX_BB_EXECUTABLE_DIR,
          ...expectedProvisionDaemonEnv,
          GITHUB_TOKEN: "github-token",
        },
        lifecycle: { onTimeout: "pause" },
      }),
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(daemonStartCommand, {
      background: true,
      envs: {
        ...expectedProvisionDaemonEnv,
        GITHUB_TOKEN: "github-token",
      },
    });
  });

  it("does not implicitly forward provider keys from process.env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic-key");

    const sandbox = createMockSandbox();
    sandbox.commands.run
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pid: 321 })
      .mockResolvedValueOnce({ stdout: `${SANDBOX_DAEMON_HEALTH_RESPONSE}\n` });
    sandboxCreateMock.mockResolvedValue(sandbox);

    await provisionHost({
      daemonArtifacts: testDaemonArtifacts,
      daemonEnv: {},
      enrollKey: "enroll-token",
      hostId: "host-123",
      hostName: "sandbox-123",
      serverUrl: "https://bb.example.test",
      template: testSandboxTemplate,
    });

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      testSandboxTemplate,
      expect.objectContaining({
        envs: expectedProvisionDaemonEnv,
      }),
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(daemonStartCommand, {
      background: true,
      envs: expectedProvisionDaemonEnv,
    });
  });
});
