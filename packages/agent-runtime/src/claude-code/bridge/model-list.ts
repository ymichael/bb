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
  // Claude exposes the live model catalog on session initialization, so we
  // open a zero-turn probe session and read only initializationResult().
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
