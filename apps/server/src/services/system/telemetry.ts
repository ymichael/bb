import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULTS } from "@bb/config/defaults";
import { readOrCreateSecretFile } from "@bb/secret-storage";
import type { AppSurface, RequestAppSurface } from "@bb/config/app-surface";
import type { ServerLogger } from "../../types.js";

const POSTHOG_INGESTION_URL = "https://us.i.posthog.com/capture/";
const TELEMETRY_ID_FILE_NAME = "telemetry-id";

const telemetryAppSurfaceStorage = new AsyncLocalStorage<RequestAppSurface>();

export type TelemetryEvent =
  | { name: "app_started" }
  | {
      name: "thread_created";
      properties: {
        is_child_thread: boolean;
        provider: string;
      };
    }
  | {
      name: "user_message_sent";
      properties: {
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        provider: string;
      };
    }
  | {
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
      };
    };

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
}

interface CreateTelemetryServiceArgs {
  apiKey: string;
  appSurface: AppSurface;
  appVersion: string;
  dataDir: string;
  enabled: boolean;
  logger: ServerLogger;
}

const noopTelemetryService: TelemetryService = {
  capture: () => {},
};

export function createNoopTelemetryService(): TelemetryService {
  return noopTelemetryService;
}

export function runWithTelemetryAppSurface<T>(
  appSurface: RequestAppSurface,
  callback: () => T,
): T {
  return telemetryAppSurfaceStorage.run(appSurface, callback);
}

export async function createTelemetryService(
  args: CreateTelemetryServiceArgs,
): Promise<TelemetryService> {
  if (
    !args.enabled ||
    args.apiKey.length === 0 ||
    args.appVersion === DEFAULTS.appVersion
  ) {
    return noopTelemetryService;
  }
  const distinctId = await readOrCreateSecretFile({
    bytes: 16,
    dataDir: args.dataDir,
    encoding: "hex",
    fileName: TELEMETRY_ID_FILE_NAME,
  });
  const commonProperties = {
    app_version: args.appVersion,
    arch: process.arch,
    platform: process.platform,
  };
  return {
    capture(event: TelemetryEvent): void {
      const appSurface =
        telemetryAppSurfaceStorage.getStore() ?? args.appSurface;
      const eventProperties = "properties" in event ? event.properties : {};
      const body = JSON.stringify({
        api_key: args.apiKey,
        distinct_id: distinctId,
        event: event.name,
        properties: {
          ...commonProperties,
          ...eventProperties,
          app_surface: appSurface,
        },
        timestamp: new Date().toISOString(),
      });
      fetch(POSTHOG_INGESTION_URL, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      }).catch((error: unknown) => {
        args.logger.debug(
          {
            app_surface: appSurface,
            err: error,
            event: event.name,
          },
          "Telemetry event send failed",
        );
      });
    },
  };
}
