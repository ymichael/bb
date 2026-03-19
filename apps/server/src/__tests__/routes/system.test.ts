import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type {
  AvailableModel,
  OpenPathRequest,
  SystemEnvironmentInfo,
  SystemHealthReport,
  SystemProviderInfo,
  Thread,
  ThreadOrchestrator,
} from "@bb/core";
import { createSystemRoutes } from "../../routes/system.js";
import { invalidRequestError } from "../../domain-errors.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    providerId: "codex",
    type: "standard",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeModel(overrides: Partial<AvailableModel> = {}): AvailableModel {
  return {
    id: "gpt-5.2-codex",
    model: "gpt-5.2-codex",
    displayName: "gpt-5.2-codex",
    description: "Frontier coding model",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low effort" },
      { reasoningEffort: "medium", description: "Medium effort" },
      { reasoningEffort: "high", description: "High effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
    ...overrides,
  };
}

function mockOrchestrator(): ThreadOrchestrator {
  const environmentInfo: SystemEnvironmentInfo = {
    id: "local",
    displayName: "Local Workspace",
    capabilities: {
      host_filesystem: true,
      isolated_workspace: false,
      promote_primary_checkout: false,
      demote_primary_checkout: false,
      squash_merge: false,
    },
  };

  return {
    list: vi.fn(),
    listAsync: vi.fn(),
    getRawById: vi.fn(),
    getById: vi.fn(),
    isPrimaryCheckoutActive: vi.fn(),
    getHydratedByIdAsync: vi.fn(),
    getWorkStatus: vi.fn(),
    getWorkStatusAsync: vi.fn(),
    getGitDiff: vi.fn(),
    getGitDiffAsync: vi.fn(),
    getProjectWorkspaceStatusAsync: vi.fn(),
    getRunningCount: vi.fn(),
    listModels: vi.fn(),
    getProviderInfo: vi.fn(),
    listProviders: vi.fn().mockResolvedValue([]),
    listEnvironments: vi.fn(() => [environmentInfo]),
  } as unknown as ThreadOrchestrator;
}

describe("System routes", () => {
  let threadManager: ReturnType<typeof mockOrchestrator>;
  let pickFolder: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  let listModels: ReturnType<typeof vi.fn<() => Promise<AvailableModel[]>>>;
  let getProviderInfo: ReturnType<typeof vi.fn<() => Promise<SystemProviderInfo>>>;
  let getHealthReport: ReturnType<typeof vi.fn<() => SystemHealthReport>>;
  let transcribeVoice: ReturnType<
    typeof vi.fn<
      (args: { file: File; prompt?: string }) => Promise<{ text: string }>
    >
  >;
  let openPath: ReturnType<typeof vi.fn<(args: OpenPathRequest) => void>>;
  let app: Hono;
  const startTime = Date.now() - 3600_000;

  beforeEach(() => {
    threadManager = mockOrchestrator();
    pickFolder = vi.fn();
    listModels = vi.fn();
    getProviderInfo = vi.fn();
    getHealthReport = vi.fn();
    transcribeVoice = vi.fn().mockResolvedValue({ text: "transcribed prompt" });
    openPath = vi.fn();
    const routes = createSystemRoutes(threadManager, startTime, {
      pickFolder,
      listModels,
      getProviderInfo,
      getHealthReport,
      transcribeVoice,
      openPath,
    });
    app = new Hono().route("/system", routes);
  });

  describe("GET /system/status", () => {
    it("returns system status with correct counts", async () => {
      const threads = [
        makeThread({ id: "t1" }),
        makeThread({ id: "t2", status: "idle" }),
        makeThread({ id: "t3", status: "idle" }),
      ];
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue(threads);
      (threadManager.getRunningCount as ReturnType<typeof vi.fn>).mockReturnValue(1);

      const res = await app.request("/system/status");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runningThreads).toBe(1);
      expect(body.totalThreads).toBe(3);
      expect(body.uptime).toBeGreaterThanOrEqual(3599);
      expect(body.uptime).toBeLessThanOrEqual(3601);
    });

    it("returns zeros when no threads", async () => {
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (threadManager.getRunningCount as ReturnType<typeof vi.fn>).mockReturnValue(0);

      const res = await app.request("/system/status");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runningThreads).toBe(0);
      expect(body.totalThreads).toBe(0);
    });

    it("returns 500 when threadManager.list() throws", async () => {
      (threadManager.list as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB connection lost");
      });

      const res = await app.request("/system/status");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe("DB connection lost");
    });
  });

  describe("GET /system/health", () => {
    it("returns the provided system health report", async () => {
      getHealthReport.mockReturnValue({
        generatedAt: 1_700_000_000_000,
        uptime: 3600,
        projectCount: 2,
        runningThreads: 1,
        threadCounts: {
          total: 4,
          archived: 1,
          created: 0,
          provisioning: 1,
          provisioned: 0,
          provisioningFailed: 0,
          error: 0,
          active: 1,
          idle: 2,
        },
        environmentDaemon: {
          activeSessionCount: 1,
          activeSessions: [
            {
              sessionId: "session-1",
              environmentId: "env-1",
              agentId: "environment-daemon:thread-1",
              agentInstanceId: "instance-1",
              protocolVersion: 1,
              worker: {
                name: "environment-daemon",
                version: "0.0.1",
              },
              providers: [
                {
                  providerId: "codex",
                  adapterVersion: "0.0.1",
                },
              ],
              selectedCapabilities: {
                commands: [
                  "provider.ensure",
                  "thread.start",
                  "thread.resume",
                  "turn.run",
                ],
                features: ["worker_metadata", "provider_metadata"],
              },
              compatibility: {
                disposition: "degrade",
                missingRequiredCommands: [],
                missingOptionalCommands: [
                  "thread.rename",
                  "provider.list_catalog",
                  "workspace.status",
                  "workspace.diff",
                ],
                missingOptionalFeatures: [
                  "provider_runtime_version",
                  "control_endpoint",
                ],
              },
              leaseExpiresAt: 1_700_000_045_000,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
            },
          ],
        },
        storage: {
          totalBytes: 4096,
          buckets: [
            {
              key: "worktrees",
              label: "Worktrees",
              bytes: 2048,
              paths: ["/tmp/worktrees"],
            },
          ],
        },
      });

      const res = await app.request("/system/health");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        generatedAt: 1_700_000_000_000,
        uptime: 3600,
        projectCount: 2,
        runningThreads: 1,
        threadCounts: {
          total: 4,
          archived: 1,
          created: 0,
          provisioning: 1,
          provisioned: 0,
          provisioningFailed: 0,
          error: 0,
          active: 1,
          idle: 2,
        },
        environmentDaemon: {
          activeSessionCount: 1,
          activeSessions: [
            {
              sessionId: "session-1",
              environmentId: "env-1",
              agentId: "environment-daemon:thread-1",
              agentInstanceId: "instance-1",
              protocolVersion: 1,
              worker: {
                name: "environment-daemon",
                version: "0.0.1",
              },
              providers: [
                {
                  providerId: "codex",
                  adapterVersion: "0.0.1",
                },
              ],
              selectedCapabilities: {
                commands: [
                  "provider.ensure",
                  "thread.start",
                  "thread.resume",
                  "turn.run",
                ],
                features: ["worker_metadata", "provider_metadata"],
              },
              compatibility: {
                disposition: "degrade",
                missingRequiredCommands: [],
                missingOptionalCommands: [
                  "thread.rename",
                  "provider.list_catalog",
                  "workspace.status",
                  "workspace.diff",
                ],
                missingOptionalFeatures: [
                  "provider_runtime_version",
                  "control_endpoint",
                ],
              },
              leaseExpiresAt: 1_700_000_045_000,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
            },
          ],
        },
        storage: {
          totalBytes: 4096,
          buckets: [
            {
              key: "worktrees",
              label: "Worktrees",
              bytes: 2048,
              paths: ["/tmp/worktrees"],
            },
          ],
        },
      });
    });

    it("returns 500 when the health report fails", async () => {
      getHealthReport.mockImplementation(() => {
        throw new Error("health lookup failed");
      });

      const res = await app.request("/system/health");

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        code: "internal_error",
        message: "health lookup failed",
      });
    });
  });

  describe("POST /system/pick-folder", () => {
    it("returns selected folder path", async () => {
      pickFolder.mockResolvedValue("/Users/michael/Projects/bb");

      const res = await app.request("/system/pick-folder", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBe("/Users/michael/Projects/bb");
    });

    it("returns null when user cancels selection", async () => {
      pickFolder.mockResolvedValue(null);

      const res = await app.request("/system/pick-folder", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBeNull();
    });

    it("returns 500 when picker fails", async () => {
      pickFolder.mockRejectedValue(new Error("picker unavailable"));

      const res = await app.request("/system/pick-folder", { method: "POST" });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe("picker unavailable");
    });
  });

  describe("POST /system/voice-transcription", () => {
    it("transcribes uploaded audio and returns text", async () => {
      const formData = new FormData();
      formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));
      formData.set("prompt", "existing prompt context");

      const res = await app.request("/system/voice-transcription", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "transcribed prompt" });
      expect(transcribeVoice).toHaveBeenCalledWith({
        file: expect.any(File),
        prompt: "existing prompt context",
      });
    });

    it("returns 400 when file field is missing", async () => {
      const formData = new FormData();
      formData.set("prompt", "hello");

      const res = await app.request("/system/voice-transcription", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        message: "Expected multipart file field named 'file'",
      });
      expect(transcribeVoice).not.toHaveBeenCalled();
    });

    it("returns 500 when transcription fails", async () => {
      transcribeVoice.mockRejectedValueOnce(new Error("transcription failed"));
      const formData = new FormData();
      formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

      const res = await app.request("/system/voice-transcription", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe("transcription failed");
    });

    it("returns 400 when transcription returns invalid_request", async () => {
      transcribeVoice.mockRejectedValueOnce(
        invalidRequestError("Voice transcription is not configured."),
      );
      const formData = new FormData();
      formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

      const res = await app.request("/system/voice-transcription", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        message: "Voice transcription is not configured.",
      });
    });
  });

  describe("POST /system/open-path", () => {
    it("opens absolute paths with optional editor preference", async () => {
      const res = await app.request("/system/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: process.cwd(),
          target: "directory",
          editor: "cursor",
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(openPath).toHaveBeenCalledWith({
        path: process.cwd(),
        target: "directory",
        editor: "cursor",
      });
    });

    it("rejects non-absolute paths", async () => {
      const res = await app.request("/system/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "relative/path.txt" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("Path must be absolute");
      expect(openPath).not.toHaveBeenCalled();
    });
  });

  describe("GET /system/models", () => {
    it("returns available models from codex", async () => {
      const models = [
        makeModel(),
        makeModel({
          id: "gpt-5.3-codex",
          model: "gpt-5.3-codex",
          displayName: "gpt-5.3-codex",
          isDefault: false,
        }),
      ];
      listModels.mockResolvedValue(models);

      const res = await app.request("/system/models");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(models);
      expect(listModels).toHaveBeenCalledTimes(1);
    });

    it("returns 500 when model listing fails", async () => {
      listModels.mockRejectedValue(new Error("codex unavailable"));

      const res = await app.request("/system/models");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe("codex unavailable");
    });

    it("uses thread manager provider listing by default", async () => {
      const defaultApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          pickFolder,
        }),
      );
      const models = [makeModel({ id: "provider-model-1", model: "provider-model-1" })];
      (
        threadManager.listModels as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue(models);

      const res = await defaultApp.request("/system/models");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(models);
      expect(threadManager.listModels).toHaveBeenCalledTimes(1);
    });

    it("passes environmentId through for environment-scoped model discovery", async () => {
      listModels.mockResolvedValue([makeModel()]);

      const res = await app.request("/system/models?providerId=pi&environmentId=env-1");

      expect(res.status).toBe(200);
      expect(listModels).toHaveBeenCalledWith("pi", "env-1");
    });
  });

  describe("GET /system/provider", () => {
    it("returns provider id and capabilities", async () => {
      const providerInfo: SystemProviderInfo = {
        id: "codex",
        displayName: "Codex",
        capabilities: {
          supportsRename: true,
          supportsServiceTier: true,
        },
      };
      getProviderInfo.mockResolvedValue(providerInfo);

      const res = await app.request("/system/provider");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(providerInfo);
      expect(getProviderInfo).toHaveBeenCalledTimes(1);
    });

    it("uses thread manager provider info by default", async () => {
      const defaultApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          pickFolder,
          listModels,
        }),
      );
      const providerInfo: SystemProviderInfo = {
        id: "codex",
        displayName: "Codex",
        capabilities: {
          supportsRename: true,
          supportsServiceTier: true,
        },
      };
      (
        threadManager.getProviderInfo as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue(providerInfo);

      const res = await defaultApp.request("/system/provider");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(providerInfo);
      expect(threadManager.getProviderInfo).toHaveBeenCalledTimes(1);
    });

    it("passes environmentId through for environment-scoped provider info", async () => {
      getProviderInfo.mockResolvedValue({
        id: "pi",
        displayName: "Pi",
        capabilities: {
          supportsRename: false,
          supportsServiceTier: false,
        },
      });

      const res = await app.request("/system/provider?environmentId=env-1");

      expect(res.status).toBe(200);
      expect(getProviderInfo).toHaveBeenCalledWith("env-1");
    });
  });

  describe("GET /system/providers", () => {
    it("returns provider catalog", async () => {
      const providers: SystemProviderInfo[] = [
        {
          id: "codex",
          displayName: "Codex",
          capabilities: {
            supportsRename: true,
            supportsServiceTier: true,
          },
        },
        {
          id: "claude-code",
          displayName: "Claude Code (protocol-compatible)",
          capabilities: {
            supportsRename: true,
            supportsServiceTier: false,
          },
        },
      ];
      (
        threadManager.listProviders as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue(providers);

      const res = await app.request("/system/providers");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(providers);
      expect(threadManager.listProviders).toHaveBeenCalledTimes(1);
    });

    it("passes environmentId through for environment-scoped provider discovery", async () => {
      (
        threadManager.listProviders as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);

      const res = await app.request("/system/providers?environmentId=env-1");

      expect(res.status).toBe(200);
      expect(threadManager.listProviders).toHaveBeenCalledWith("env-1");
    });
  });

  describe("GET /system/environments", () => {
    it("returns the environment catalog", async () => {
      const environments: SystemEnvironmentInfo[] = [
        {
          id: "local",
          displayName: "Local Workspace",
          capabilities: {
            host_filesystem: true,
            isolated_workspace: false,
            promote_primary_checkout: false,
            demote_primary_checkout: false,
            squash_merge: false,
          },
        },
        {
          id: "worktree",
          displayName: "Git Worktree Workspace",
          capabilities: {
            host_filesystem: true,
            isolated_workspace: true,
            promote_primary_checkout: true,
            demote_primary_checkout: true,
            squash_merge: true,
          },
        },
      ];
      (
        threadManager.listEnvironments as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(environments);

      const environmentRes = await app.request("/system/environments");

      expect(environmentRes.status).toBe(200);
      expect(await environmentRes.json()).toEqual(environments);
      expect(threadManager.listEnvironments).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /system/restart-policy", () => {
    it("returns explicit restart semantics by thread status", async () => {
      const res = await app.request("/system/restart-policy");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        runtimeMode: "production",
        restartPolicyByStatus: {
          created: "noop",
          provisioning: "noop",
          provisioned: "noop",
          error: "noop",
          active: "noop",
          idle: "noop",
          provisioning_failed: "noop",
        },
        shutdownBlockingStatuses: ["created", "provisioning", "provisioned", "active"],
        shouldRestart: false,
      });
    });

    it("surfaces restart recommendation when provided", async () => {
      const restartAwareApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          getRuntimeMode: () => "development",
          shouldRestart: () => true,
        }),
      );

      const res = await restartAwareApp.request("/system/restart-policy");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        runtimeMode: "development",
        restartPolicyByStatus: {
          created: "noop",
          provisioning: "noop",
          provisioned: "noop",
          error: "noop",
          active: "noop",
          idle: "noop",
          provisioning_failed: "noop",
        },
        shutdownBlockingStatuses: ["created", "provisioning", "provisioned", "active"],
        shouldRestart: true,
      });
    });
  });

  describe("POST /system/shutdown", () => {
    it("returns 409 when blocking thread work exists and force is not set", async () => {
      const requestShutdown = vi.fn();
      const shutdownApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          requestShutdown,
        }),
      );
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-active", status: "active" }),
        makeThread({ id: "t-idle", status: "idle" }),
      ]);

      const res = await shutdownApp.request("/system/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: "shutdown_blocked",
        message: "Server shutdown blocked by active thread work",
        blockingThreads: [
          {
            id: "t-active",
            status: "active",
            projectId: "proj-1",
          },
        ],
      });
      expect(requestShutdown).not.toHaveBeenCalled();
    });

    it("schedules shutdown callback when no blocking work exists", async () => {
      const requestShutdown = vi.fn();
      const shutdownApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          requestShutdown,
        }),
      );
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-idle", status: "idle" }),
      ]);

      const res = await shutdownApp.request("/system/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        forced: false,
        blockingThreadsCount: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestShutdown).toHaveBeenCalledWith("system/shutdown");
    });

    it("allows forced shutdown even when active work exists", async () => {
      const requestShutdown = vi.fn();
      const shutdownApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          requestShutdown,
        }),
      );
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-active", status: "active" }),
      ]);

      const res = await shutdownApp.request("/system/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        forced: true,
        blockingThreadsCount: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestShutdown).toHaveBeenCalledWith("system/shutdown");
    });
  });

  describe("POST /system/restart", () => {
    it("returns 409 when blocking thread work exists and force is not set", async () => {
      const requestRestart = vi.fn();
      const restartApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          requestRestart,
        }),
      );
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-active", status: "active" }),
        makeThread({ id: "t-idle", status: "idle" }),
      ]);

      const res = await restartApp.request("/system/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: "shutdown_blocked",
        message: "Server shutdown blocked by active thread work",
        blockingThreads: [
          {
            id: "t-active",
            status: "active",
            projectId: "proj-1",
          },
        ],
      });
      expect(requestRestart).not.toHaveBeenCalled();
    });

    it("schedules restart callback when no blocking work exists", async () => {
      const requestRestart = vi.fn();
      const restartApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          requestRestart,
        }),
      );
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-idle", status: "idle" }),
      ]);

      const res = await restartApp.request("/system/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        forced: false,
        blockingThreadsCount: 0,
        restarting: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestRestart).toHaveBeenCalledWith("system/restart");
    });

    it("allows forced restart even when active work exists", async () => {
      const requestRestart = vi.fn();
      const restartApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager, startTime, {
          requestRestart,
        }),
      );
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-active", status: "active" }),
      ]);

      const res = await restartApp.request("/system/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        forced: true,
        blockingThreadsCount: 1,
        restarting: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestRestart).toHaveBeenCalledWith("system/restart");
    });
  });
});
