import { readFile } from "node:fs/promises";
import {
  bbAppManagedConfigSchema,
  formatBbAppConfigPath,
  type BbAppManagedConfig,
} from "@bb/config/bb-app-managed-config";
import { validateInferenceModel } from "@bb/config/inference-model";
import { validateOptionalUrl } from "@bb/config/public-url";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";

export interface ApplyBbAppManagedConfigArgs {
  baseConfig: ServerRuntimeConfig;
  managedConfig: BbAppManagedConfig;
  targetConfig: ServerRuntimeConfig;
}

export interface ReadBbAppManagedConfigArgs {
  configPath: string;
}

export interface CreateBbAppManagedConfigReloaderArgs {
  config: ServerRuntimeConfig;
  hub: NotificationHub;
  logger: ServerLogger;
}

export interface ReloadBbAppManagedConfigArgs {
  notify: boolean;
}

export interface BbAppManagedConfigReloader {
  reload(args: ReloadBbAppManagedConfigArgs): Promise<void>;
}

function cloneRuntimeConfig(config: ServerRuntimeConfig): ServerRuntimeConfig {
  return { ...config };
}

function replaceRuntimeConfig(
  targetConfig: ServerRuntimeConfig,
  nextConfig: ServerRuntimeConfig,
): void {
  if (nextConfig.appUrl === undefined) {
    delete targetConfig.appUrl;
  }
  Object.assign(targetConfig, nextConfig);
}

function setOptionalAppUrl(
  config: ServerRuntimeConfig,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete config.appUrl;
    return;
  }
  config.appUrl = value;
}

export function applyBbAppManagedConfig(
  args: ApplyBbAppManagedConfigArgs,
): void {
  const managedEnv = args.managedConfig.env ?? {};

  args.targetConfig.inferenceModel =
    managedEnv.BB_INFERENCE_MODEL !== undefined
      ? validateInferenceModel(managedEnv.BB_INFERENCE_MODEL)
      : args.baseConfig.inferenceModel;
  args.targetConfig.openAiApiKey =
    managedEnv.OPENAI_API_KEY ?? args.baseConfig.openAiApiKey;

  setOptionalAppUrl(
    args.targetConfig,
    managedEnv.BB_APP_URL !== undefined
      ? validateOptionalUrl("BB_APP_URL", managedEnv.BB_APP_URL)
      : args.baseConfig.appUrl,
  );
}

export async function readBbAppManagedConfig(
  args: ReadBbAppManagedConfigArgs,
): Promise<BbAppManagedConfig> {
  try {
    const rawConfig = await readFile(args.configPath, "utf8");
    return bbAppManagedConfigSchema.parse(JSON.parse(rawConfig));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function createBbAppManagedConfigReloader(
  args: CreateBbAppManagedConfigReloaderArgs,
): Promise<BbAppManagedConfigReloader> {
  const baseConfig = cloneRuntimeConfig(args.config);
  const configPath = formatBbAppConfigPath(args.config.dataDir);

  async function reload(
    reloadArgs: ReloadBbAppManagedConfigArgs,
  ): Promise<void> {
    const managedConfig = await readBbAppManagedConfig({ configPath });
    const nextConfig = cloneRuntimeConfig(args.config);
    applyBbAppManagedConfig({
      baseConfig,
      managedConfig,
      targetConfig: nextConfig,
    });
    replaceRuntimeConfig(args.config, nextConfig);
    if (reloadArgs.notify) {
      args.hub.notifySystem(["config-changed"]);
    }
  }

  try {
    await reload({ notify: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(
      { configPath, error: message },
      "Ignoring invalid bb-app managed config during startup",
    );
  }

  return {
    reload,
  };
}
