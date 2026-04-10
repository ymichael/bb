import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { AvailableModel } from "@bb/domain";
import {
  buildClaudeCodeAvailableModels,
  listFallbackClaudeCodeModels,
} from "../model-list.js";

function buildModelProbeOptions(): Options {
  return {
    cwd: process.cwd(),
    maxTurns: 0,
    persistSession: false,
    allowDangerouslySkipPermissions: true,
    permissionMode: "bypassPermissions",
    settingSources: [],
  };
}

export async function listClaudeCodeBridgeModels(): Promise<AvailableModel[]> {
  const session = query({
    prompt: ".",
    options: buildModelProbeOptions(),
  });

  try {
    const initialization = await session.initializationResult();
    return buildClaudeCodeAvailableModels(initialization.models);
  } catch {
    return listFallbackClaudeCodeModels();
  } finally {
    session.close();
  }
}
