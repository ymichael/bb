import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import type {
  ProviderAdapter,
  ProviderTitleGenerator,
} from "./provider-adapter.js";

export interface CreatePiMonoProviderAdapterOptions {
  titleGenerator?: ProviderTitleGenerator;
  processCommand?: string;
  processArgs?: string[];
}

export function createPiMonoProviderAdapter(
  opts?: CreatePiMonoProviderAdapterOptions,
): ProviderAdapter {
  const processCommand =
    opts?.processCommand ?? process.env.BEANBAG_PI_PROVIDER_COMMAND ?? "codex";
  const processArgs =
    opts?.processArgs ??
    (processCommand === "codex"
      ? ["app-server"]
      : processCommand === "pi-mono"
        ? ["app-server"]
        : []);

  return createCodexProviderAdapter({
    titleGenerator: opts?.titleGenerator,
    id: "pi-mono",
    displayName: "Pi Mono (protocol-compatible)",
    processCommand,
    processArgs,
  });
}
