import { Hono } from "hono";
import type {
  AvailableModel,
  SystemProviderInfo,
  SystemStatus,
} from "@beanbag/agent-core";
import type { ThreadManager } from "../thread-manager.js";
import { pickFolderPath } from "../folder-picker.js";
import { sendRouteError } from "./error-response.js";

type PickFolderFn = () => Promise<string | null>;
type ListModelsFn = () => Promise<AvailableModel[]>;
type ProviderInfoFn = () => SystemProviderInfo;

export function createSystemRoutes(
  threadManager: ThreadManager,
  startTime: number,
  pickFolder: PickFolderFn = pickFolderPath,
  listModels: ListModelsFn = () => threadManager.listModels(),
  getProviderInfo: ProviderInfoFn = () => threadManager.getProviderInfo(),
) {
  return new Hono()
    .get("/status", async (c) => {
      try {
        const runningThreads = threadManager.getRunningCount();
        const totalThreads = threadManager.list().length;

        const status: SystemStatus = {
          runningThreads,
          totalThreads,
          uptime: Math.floor((Date.now() - startTime) / 1000),
        };

        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/pick-folder", async (c) => {
      try {
        const path = await pickFolder();
        return c.json({ path });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/models", async (c) => {
      try {
        const models = await listModels();
        return c.json(models);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/provider", async (c) => {
      try {
        return c.json(getProviderInfo());
      } catch (err) {
        return sendRouteError(c, err);
      }
    });
}
