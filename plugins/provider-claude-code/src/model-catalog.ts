import type {
  AvailableModel,
  ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  CLAUDE_CODE_ACTIVE_CATALOG_DATA,
  CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "./model-catalog-data.js";

export function cloneReasoningEfforts(
  efforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort[] {
  return efforts.map((effort) => ({ ...effort }));
}

export interface ClaudeCodeCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: readonly ModelReasoningEffort[];
  defaultReasoningEffort: AvailableModel["defaultReasoningEffort"];
}

export const CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS: readonly ModelReasoningEffort[] =
  CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA.map((effort) => ({ ...effort }));

export { DEFAULT_CLAUDE_CODE_MODEL };

export const CLAUDE_CODE_ACTIVE_CATALOG: readonly ClaudeCodeCatalogEntry[] =
  CLAUDE_CODE_ACTIVE_CATALOG_DATA.map((entry) => ({
    id: entry.model,
    model: entry.model,
    displayName: entry.displayName,
    description: entry.description,
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: entry.defaultReasoningEffort,
  }));
