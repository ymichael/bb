
import type { ReasoningEffort } from "./ReasoningEffort.js";

export type Settings = { model: string, reasoning_effort: ReasoningEffort | null, developer_instructions: string | null, };
