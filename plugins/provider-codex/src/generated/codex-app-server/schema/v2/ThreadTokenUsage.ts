
import type { TokenUsageBreakdown } from "./TokenUsageBreakdown.js";

export type ThreadTokenUsage = { total: TokenUsageBreakdown, last: TokenUsageBreakdown, modelContextWindow: number | null, };
