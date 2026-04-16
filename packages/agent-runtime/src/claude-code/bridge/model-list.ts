import type { AvailableModel } from "@bb/domain";
import { listClaudeCodeModels } from "../model-list.js";

export interface ListClaudeCodeBridgeModelsArgs {
  selectedModel?: string;
}

export async function listClaudeCodeBridgeModels(
  args: ListClaudeCodeBridgeModelsArgs = {},
): Promise<AvailableModel[]> {
  return listClaudeCodeModels({ selectedModel: args.selectedModel });
}
