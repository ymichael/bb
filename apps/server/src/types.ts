import type { DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import type { SandboxHostRegistry } from "./services/sandbox-registry.js";
import type { NotificationHub } from "./ws/hub.js";

export type ServerLogger = Pick<Logger, "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  authToken: string;
  dataDir: string;
  e2bApiKey: string;
  e2bTemplate: string;
  githubPat: string;
  hostDaemonPort: number;
  inferenceModel: string;
  openAiApiKey: string;
  publicUrl: string;
}

export interface AppDeps {
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
  logger: ServerLogger;
  sandboxRegistry: SandboxHostRegistry;
}
