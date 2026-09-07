export type ClaudeCodeReasoningLevel =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode"
  | "max";

export interface ClaudeCodeReasoningEffortData {
  reasoningEffort: ClaudeCodeReasoningLevel;
  description: string;
}

export interface ClaudeCodeCatalogEntryData {
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ClaudeCodeReasoningLevel;
}

export const CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA: readonly ClaudeCodeReasoningEffortData[] =
  [
    { reasoningEffort: "low", description: "Low reasoning effort" },
    { reasoningEffort: "medium", description: "Medium reasoning effort" },
    { reasoningEffort: "high", description: "High reasoning effort" },
    { reasoningEffort: "xhigh", description: "Extra high reasoning effort" },
    {
      reasoningEffort: "ultracode",
      description:
        "Extra high reasoning effort plus multi-agent workflow orchestration",
    },
    { reasoningEffort: "max", description: "Maximum reasoning effort" },
  ];

export const DEFAULT_CLAUDE_CODE_MODEL = "claude-opus-5[1m]";

export const CLAUDE_CODE_ACTIVE_CATALOG_DATA: readonly ClaudeCodeCatalogEntryData[] =
  [
    {
      model: "claude-fable-5-1",
      displayName: "Fable 5.1",
      description:
        "Fable 5.1 for demanding reasoning; requires Claude Code v2.1.257+",
      defaultReasoningEffort: "high",
    },
    {
      model: DEFAULT_CLAUDE_CODE_MODEL,
      displayName: "Opus 5 (1M)",
      description: "Opus 5 with 1M context for complex long coding sessions",
      defaultReasoningEffort: "high",
    },
    {
      model: "claude-opus-4-8[1m]",
      displayName: "Opus 4.8 (1M)",
      description: "Opus 4.8 with 1M context for complex long coding sessions",
      defaultReasoningEffort: "high",
    },
    {
      model: "claude-opus-4-7[1m]",
      displayName: "Opus 4.7 (1M)",
      description: "Opus 4.7 with 1M context for complex long coding sessions",
      defaultReasoningEffort: "medium",
    },
    {
      model: "claude-sonnet-5",
      displayName: "Sonnet 5",
      description: "Sonnet 5 for everyday coding tasks with deeper reasoning",
      defaultReasoningEffort: "medium",
    },
  ];
