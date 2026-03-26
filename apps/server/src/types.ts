import type { DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import type { NotificationHub } from "./ws/hub.js";

export type ServerLogger = Pick<Logger, "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  authToken: string;
  dataDir: string;
  hostDaemonPort: number | null;
  inferenceModel: string;
  openAiApiKey: string;
  serverUrl: string;
}

export interface AppDeps {
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
  logger: ServerLogger;
}
