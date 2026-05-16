import { join } from "node:path";
import { z } from "zod";

export const BB_APP_CONFIG_FILE_NAME = "config.json";

export type BbAppManagedEnvKey =
  | "BB_APP_URL"
  | "BB_INFERENCE_MODEL"
  | "BB_LOG_LEVEL"
  | "OPENAI_API_KEY";

export const BB_APP_MANAGED_ENV_KEYS: BbAppManagedEnvKey[] = [
  "BB_APP_URL",
  "BB_INFERENCE_MODEL",
  "BB_LOG_LEVEL",
  "OPENAI_API_KEY",
];

export const BB_APP_SECRET_MANAGED_ENV_KEYS: BbAppManagedEnvKey[] = [
  "OPENAI_API_KEY",
];

export const bbAppManagedEnvConfigSchema = z
  .object({
    BB_APP_URL: z.string().optional(),
    BB_INFERENCE_MODEL: z.string().optional(),
    BB_LOG_LEVEL: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
  })
  .strict();

export const bbAppManagedConfigSchema = z
  .object({
    env: bbAppManagedEnvConfigSchema.optional(),
    serverUrl: z.string().min(1).optional(),
  })
  .strict();

export type BbAppManagedEnvConfig = z.infer<typeof bbAppManagedEnvConfigSchema>;
export type BbAppManagedConfig = z.infer<typeof bbAppManagedConfigSchema>;

export function formatBbAppConfigPath(dataDir: string): string {
  return join(dataDir, BB_APP_CONFIG_FILE_NAME);
}
