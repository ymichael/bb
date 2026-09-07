import { readFile } from "node:fs/promises";
import {
  bbAppManagedEnvFileSchema,
  formatBbAppConfigPath,
  formatBbAppEnvPath,
  parseBbAppManagedConfig,
  type BbAppManagedConfig,
  type BbAppManagedEnvConfig,
  type BbAppManagedEnvFile,
} from "@bb/config/bb-app-managed-config";
import {
  validateInferenceFallbackModel,
  validateInferenceModel,
  validateTranscriptionModel,
} from "@bb/config/inference-model";
import { validateOptionalUrl } from "@bb/config/public-url";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";

interface ApplyBbAppManagedConfigArgs {
  baseConfig: ServerRuntimeConfig;
  managedConfig: BbAppManagedConfig;
  managedEnvFile: BbAppManagedEnvFile;
  targetConfig: ServerRuntimeConfig;
}

interface ReadBbAppManagedConfigArgs {
  configPath: string;
  logger?: ServerLogger;
}

interface ReadBbAppManagedEnvArgs {
  envPath: string;
}

interface CreateBbAppManagedConfigReloaderArgs {
  config: ServerRuntimeConfig;
  hub: NotificationHub;
  logger: ServerLogger;
}

interface ReloadBbAppManagedConfigArgs {
  notify: boolean;
}

export interface BbAppManagedConfigReloader {
  reload(args: ReloadBbAppManagedConfigArgs): Promise<void>;
}

interface ApplyManagedProcessEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  managedEnv: BbAppManagedEnvConfig;
  managedKeys: Set<string>;
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

function applyManagedProcessEnv(args: ApplyManagedProcessEnvArgs): void {
  for (const key of args.managedKeys) {
    const baseValue = args.baseEnv[key];
    if (baseValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseValue;
    }
  }

  args.managedKeys.clear();
  for (const [key, value] of Object.entries(args.managedEnv)) {
    process.env[key] = value;
    args.managedKeys.add(key);
  }
}

export function applyBbAppManagedConfig(
  args: ApplyBbAppManagedConfigArgs,
): void {
  const managedConfig = args.managedConfig.config ?? {};
  const managedEnv = args.managedEnvFile.env ?? {};

  args.targetConfig.customModels =
    args.managedConfig.customModels ?? args.baseConfig.customModels;
  args.targetConfig.sharedSkillRoots =
    args.managedConfig.sharedSkillRoots ?? args.baseConfig.sharedSkillRoots;
  args.targetConfig.inferenceModel =
    managedConfig.BB_INFERENCE !== undefined
      ? validateInferenceModel(managedConfig.BB_INFERENCE)
      : args.baseConfig.inferenceModel;
  args.targetConfig.inferenceFallbackModel =
    managedConfig.BB_INFERENCE_FALLBACK !== undefined
      ? validateInferenceFallbackModel(managedConfig.BB_INFERENCE_FALLBACK)
      : args.baseConfig.inferenceFallbackModel;
  args.targetConfig.transcriptionModel =
    managedConfig.BB_TRANSCRIPTION !== undefined
      ? validateTranscriptionModel(managedConfig.BB_TRANSCRIPTION)
      : args.baseConfig.transcriptionModel;
  args.targetConfig.openAiApiKey =
    managedEnv.OPENAI_API_KEY ?? args.baseConfig.openAiApiKey;

  setOptionalAppUrl(
    args.targetConfig,
    managedConfig.BB_APP_URL !== undefined
      ? validateOptionalUrl("BB_APP_URL", managedConfig.BB_APP_URL)
      : args.baseConfig.appUrl,
  );
}

async function readBbAppManagedConfig(
  args: ReadBbAppManagedConfigArgs,
): Promise<BbAppManagedConfig> {
  try {
    const rawConfig = await readFile(args.configPath, "utf8");
    return parseBbAppManagedConfig(JSON.parse(rawConfig), {
      logger: args.logger,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readBbAppManagedEnv(
  args: ReadBbAppManagedEnvArgs,
): Promise<BbAppManagedEnvFile> {
  try {
    const rawConfig = await readFile(args.envPath, "utf8");
    return bbAppManagedEnvFileSchema.parse(JSON.parse(rawConfig));
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
  const baseEnv = { ...process.env };
  const configPath = formatBbAppConfigPath(args.config.dataDir);
  const envPath = formatBbAppEnvPath(args.config.dataDir);
  const managedEnvKeys = new Set<string>();

  async function reload(
    reloadArgs: ReloadBbAppManagedConfigArgs,
  ): Promise<void> {
    const managedConfig = await readBbAppManagedConfig({
      configPath,
      logger: args.logger,
    });
    const managedEnvFile = await readBbAppManagedEnv({ envPath });
    const nextConfig = cloneRuntimeConfig(args.config);
    applyBbAppManagedConfig({
      baseConfig,
      managedConfig,
      managedEnvFile,
      targetConfig: nextConfig,
    });
    applyManagedProcessEnv({
      baseEnv,
      managedEnv: managedEnvFile.env ?? {},
      managedKeys: managedEnvKeys,
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
