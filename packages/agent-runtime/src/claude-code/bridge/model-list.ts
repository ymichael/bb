import type { AvailableModel } from "@bb/domain";
import { listClaudeCodeModels } from "../model-list.js";

export async function listClaudeCodeBridgeModels(): Promise<AvailableModel[]> {
  return listClaudeCodeModels();
}
