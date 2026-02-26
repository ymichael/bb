import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import type {
  ProviderAdapter,
  ProviderTitleGenerator,
} from "./provider-adapter.js";

export interface CreateClaudeCodeProviderAdapterOptions {
  titleGenerator?: ProviderTitleGenerator;
  processCommand?: string;
  processArgs?: string[];
}

export function createClaudeCodeProviderAdapter(
  opts?: CreateClaudeCodeProviderAdapterOptions,
): ProviderAdapter {
  const processCommand =
    opts?.processCommand ??
    process.env.BEANBAG_CLAUDE_PROVIDER_COMMAND ??
    "codex";
  const processArgs =
    opts?.processArgs ??
    (processCommand === "codex"
      ? ["app-server"]
      : processCommand === "claude-code"
        ? ["app-server"]
        : []);

  return createCodexProviderAdapter({
    titleGenerator: opts?.titleGenerator,
    id: "claude-code",
    displayName: "Claude Code (protocol-compatible)",
    processCommand,
    processArgs,
    capabilities: {
      supportsSteer: false,
      supportsModelList: false,
      supportsReasoningLevels: false,
    },
    listModels: async () => [],
  });
}
