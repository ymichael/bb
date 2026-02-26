import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AvailableModel, SystemProviderInfo, Thread } from "@beanbag/agent-core";
import { createSystemRoutes } from "../../routes/system.js";
import type { ThreadManager } from "../../thread-manager.js";

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

function mockThreadManager(): ThreadManager {
  return {
    list: vi.fn(),
    getRunningCount: vi.fn(),
    listModels: vi.fn(),
    getProviderInfo: vi.fn(),
  } as unknown as ThreadManager;
}

describe("System routes", () => {
  let threadManager: ReturnType<typeof mockThreadManager>;
  let pickFolder: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  let listModels: ReturnType<typeof vi.fn<() => Promise<AvailableModel[]>>>;
  let getProviderInfo: ReturnType<typeof vi.fn<() => SystemProviderInfo>>;
  let app: Hono;
  const startTime = Date.now() - 3600_000;

  beforeEach(() => {
    threadManager = mockThreadManager();
    pickFolder = vi.fn();
    listModels = vi.fn();
    getProviderInfo = vi.fn();
    const routes = createSystemRoutes(
      threadManager as any,
      startTime,
      pickFolder,
      listModels,
      getProviderInfo,
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
});
