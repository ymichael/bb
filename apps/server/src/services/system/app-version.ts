import semver from "semver";
import { z } from "zod";
import type { SystemVersionResponse } from "@bb/server-contract";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";

const NPM_LATEST_URL = "https://registry.npmjs.org/bb-app/latest";
const NPM_LATEST_TIMEOUT_MS = 5_000;
const NPM_LATEST_CACHE_TTL_MS = 60 * 60 * 1000;
const UPGRADE_COMMAND = "npx bb-app@latest";

const npmLatestResponseSchema = z
  .object({
    version: z.string().min(1),
  })
  .passthrough();

export interface AppVersionService {
  getSystemVersion(
    args?: AppVersionGetSystemVersionArgs,
  ): Promise<SystemVersionResponse>;
}

interface AppVersionGetSystemVersionArgs {
  forceRefresh?: boolean;
}

interface CreateAppVersionServiceArgs {
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
  fetchImpl?: typeof fetch;
  logger: ServerLogger;
  cacheTtlMs?: number;
  now?: () => number;
}

interface NpmLatestCacheEntry {
  cachedAt: number;
  latestVersion: string;
}

export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  const fetchImpl = args.fetchImpl ?? fetch;
  const cacheTtlMs = args.cacheTtlMs ?? NPM_LATEST_CACHE_TTL_MS;
  const now = args.now ?? (() => Date.now());
  const logger = args.logger;
  const config = args.config;

  let cache: NpmLatestCacheEntry | null = null;
  let inflight: Promise<string | null> | null = null;

  async function fetchNpmLatest(): Promise<string | null> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      NPM_LATEST_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(NPM_LATEST_URL, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, url: NPM_LATEST_URL },
          "Failed to fetch latest bb-app version from npm",
        );
        return null;
      }
      const json = await response.json();
      const parsed = npmLatestResponseSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn(
          { url: NPM_LATEST_URL, issue: parsed.error.message },
          "npm latest response did not match expected shape",
        );
        return null;
      }
      return parsed.data.version;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { url: NPM_LATEST_URL, error: message },
        "npm latest lookup failed",
      );
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function getLatestVersion(args?: {
    forceRefresh?: boolean;
  }): Promise<string | null> {
    const currentTime = now();
    if (
      args?.forceRefresh !== true &&
      cache !== null &&
      currentTime - cache.cachedAt < cacheTtlMs
    ) {
      return cache.latestVersion;
    }
    if (inflight !== null) {
      return inflight;
    }
    const requestPromise = (async () => {
      const result = await fetchNpmLatest();
      if (result !== null) {
        cache = { cachedAt: now(), latestVersion: result };
      }
      return result;
    })();
    inflight = requestPromise;
    try {
      return await requestPromise;
    } finally {
      if (inflight === requestPromise) {
        inflight = null;
      }
    }
  }

  return {
    async getSystemVersion(
      args: AppVersionGetSystemVersionArgs = {},
    ): Promise<SystemVersionResponse> {
      const baseResponse: SystemVersionResponse = {
        currentVersion: config.appVersion,
        latestVersion: null,
        source: "npm",
        updateAvailable: false,
        isDevelopment: config.isDevelopment,
        upgradeCommand: UPGRADE_COMMAND,
      };

      if (config.isDevelopment) {
        return baseResponse;
      }

      const latestVersion = await getLatestVersion({
        forceRefresh: args.forceRefresh,
      });
      if (latestVersion === null) {
        return baseResponse;
      }

      const parsedCurrent = semver.parse(config.appVersion);
      const parsedLatest = semver.parse(latestVersion);
      if (parsedCurrent === null || parsedLatest === null) {
        logger.warn(
          {
            currentVersion: config.appVersion,
            latestVersion,
          },
          "Skipping update check because a version is not valid semver",
        );
        return { ...baseResponse, latestVersion };
      }

      return {
        ...baseResponse,
        latestVersion,
        updateAvailable: semver.gt(parsedLatest, parsedCurrent),
      };
    },
  };
}
