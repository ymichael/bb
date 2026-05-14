import type { AvailableModel } from "@bb/domain";
import { listClaudeCodeModels } from "../model-list.js";

export async function listClaudeCodeBridgeModels(): Promise<{
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}> {
  return listClaudeCodeModels();
}
