import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import type {
  ProviderAdapter,
  ProviderTitleGenerator,
} from "./provider-adapter.js";

export interface CreatePiMonoProviderAdapterOptions {
  titleGenerator?: ProviderTitleGenerator;
  /**
   * Command used by the bridge to start Pi (defaults to `pi`).
   */
  processCommand?: string;
  /**
   * Additional args passed through to the Pi command.
   */
  processArgs?: string[];
}

function resolvePiBridgeEntryPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "pi-rpc-bridge.js");
}

export function createPiMonoProviderAdapter(
  opts?: CreatePiMonoProviderAdapterOptions,
): ProviderAdapter {
  const piCommand =
    opts?.processCommand ?? process.env.BEANBAG_PI_PROVIDER_COMMAND ?? "pi";
  const piArgs = opts?.processArgs ?? [];
  const bridgeEntryPath = resolvePiBridgeEntryPath();
  const bridgeArgs = [
    bridgeEntryPath,
    "--pi-command",
    piCommand,
    ...piArgs.flatMap((arg) => ["--pi-arg", arg]),
  ];

  return createCodexProviderAdapter({
    titleGenerator: opts?.titleGenerator,
    id: "pi-mono",
    displayName: "Pi Mono (RPC bridge)",
    processCommand: process.execPath,
    processArgs: bridgeArgs,
    capabilities: {
      supportsModelList: false,
    },
    listModels: async () => [],
  });
}
