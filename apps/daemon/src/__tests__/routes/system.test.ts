import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type {
  AvailableModel,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  Thread,
  ThreadOrchestrator,
} from "@beanbag/agent-core";
import { createSystemRoutes } from "../../routes/system.js";
import { invalidRequestError } from "../../domain-errors.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
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

function mockThreadManager(): ThreadOrchestrator {
  const environmentInfo: SystemEnvironmentInfo = {
    id: "local",
    displayName: "Local Workspace",
    capabilities: {
      isolatedFilesystem: false,
      ephemeralWorkspace: false,
      supportsCleanup: false,
    },
  };

  return {
    list: vi.fn(),
    getWorkStatus: vi.fn(),
    getRunningCount: vi.fn(),
    listModels: vi.fn(),
    getProviderInfo: vi.fn(),
    listProviders: vi.fn(() => []),
    getEnvironmentInfo: vi.fn(() => environmentInfo),
    listEnvironments: vi.fn(() => [environmentInfo]),
  } as unknown as ThreadOrchestrator;
}

describe("System routes", () => {
  let threadManager: ReturnType<typeof mockThreadManager>;
  let pickFolder: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  let listModels: ReturnType<typeof vi.fn<() => Promise<AvailableModel[]>>>;
  let getProviderInfo: ReturnType<typeof vi.fn<() => SystemProviderInfo>>;
  let transcribeVoice: ReturnType<
    typeof vi.fn<
      (args: { file: File; prompt?: string }) => Promise<{ text: string }>
    >
  >;
  let app: Hono;
  const startTime = Date.now() - 3600_000;

  beforeEach(() => {
    threadManager = mockThreadManager();
    pickFolder = vi.fn();
    listModels = vi.fn();
    getProviderInfo = vi.fn();
    transcribeVoice = vi.fn().mockResolvedValue({ text: "transcribed prompt" });
    const routes = createSystemRoutes(
      threadManager as any,
      startTime,
      pickFolder,
      listModels,
      getProviderInfo,
      undefined,
      undefined,
      undefined,
      transcribeVoice,
    );
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
      expect(body.error).toBe("DB connection lost");
    });
  });

  describe("POST /system/pick-folder", () => {
    it("returns selected folder path", async () => {
      pickFolder.mockResolvedValue("/Users/michael/Projects/beanbag");

      const res = await app.request("/system/pick-folder", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBe("/Users/michael/Projects/beanbag");
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
      expect(body.error).toBe("picker unavailable");
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
        error: "Expected multipart file field named 'file'",
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
      expect(body.error).toBe("transcription failed");
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
        error: "Voice transcription is not configured.",
      });
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
      expect(body.error).toBe("codex unavailable");
    });

    it("uses thread manager provider listing by default", async () => {
      const defaultApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager as any, startTime, pickFolder),
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
  });

  describe("GET /system/provider", () => {
    it("returns provider id and capabilities", async () => {
      const providerInfo: SystemProviderInfo = {
        id: "codex",
        displayName: "Codex app-server",
        capabilities: {
          supportsSteer: true,
          supportsRename: true,
          supportsModelList: true,
          supportsReasoningLevels: true,
          supportsMultimodalInput: true,
        },
      };
      getProviderInfo.mockReturnValue(providerInfo);

      const res = await app.request("/system/provider");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(providerInfo);
      expect(getProviderInfo).toHaveBeenCalledTimes(1);
    });

    it("uses thread manager provider info by default", async () => {
      const defaultApp = new Hono().route(
        "/system",
        createSystemRoutes(threadManager as any, startTime, pickFolder, listModels),
      );
      const providerInfo: SystemProviderInfo = {
        id: "codex",
        displayName: "Codex app-server",
        capabilities: {
          supportsSteer: true,
          supportsRename: true,
          supportsModelList: true,
          supportsReasoningLevels: true,
          supportsMultimodalInput: true,
        },
      };
      (
        threadManager.getProviderInfo as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(providerInfo);

      const res = await defaultApp.request("/system/provider");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(providerInfo);
      expect(threadManager.getProviderInfo).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /system/providers", () => {
    it("returns provider catalog", async () => {
      const providers: SystemProviderInfo[] = [
        {
          id: "codex",
          displayName: "Codex app-server",
          capabilities: {
            supportsSteer: true,
            supportsRename: true,
            supportsModelList: true,
            supportsReasoningLevels: true,
            supportsMultimodalInput: true,
          },
        },
        {
          id: "claude-code",
          displayName: "Claude Code (protocol-compatible)",
          capabilities: {
            supportsSteer: false,
            supportsRename: true,
            supportsModelList: false,
            supportsReasoningLevels: false,
            supportsMultimodalInput: true,
          },
        },
      ];
      (
        threadManager.listProviders as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(providers);

      const res = await app.request("/system/providers");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(providers);
      expect(threadManager.listProviders).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /system/environment + /system/environments", () => {
    it("returns active environment and environment catalog", async () => {
      const activeEnvironment: SystemEnvironmentInfo = {
        id: "worktree",
        displayName: "Git Worktree Workspace",
        capabilities: {
          isolatedFilesystem: true,
          ephemeralWorkspace: true,
          supportsCleanup: true,
        },
      };
      const environments: SystemEnvironmentInfo[] = [
        {
          id: "local",
          displayName: "Local Workspace",
          capabilities: {
            isolatedFilesystem: false,
            ephemeralWorkspace: false,
            supportsCleanup: false,
          },
        },
        activeEnvironment,
      ];

      (
        threadManager.getEnvironmentInfo as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(activeEnvironment);
      (
        threadManager.listEnvironments as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(environments);

      const [activeRes, allRes] = await Promise.all([
        app.request("/system/environment"),
        app.request("/system/environments"),
      ]);

      expect(activeRes.status).toBe(200);
      expect(await activeRes.json()).toEqual(activeEnvironment);
      expect(allRes.status).toBe(200);
      expect(await allRes.json()).toEqual(environments);
      expect(threadManager.getEnvironmentInfo).toHaveBeenCalledTimes(1);
      expect(threadManager.listEnvironments).toHaveBeenCalledTimes(1);
    });
  });
});
