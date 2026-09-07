
import type { SubAgentSource } from "../SubAgentSource.js";

export type SessionSource = "cli" | "vscode" | "exec" | "appServer" | { "custom": string } | { "subAgent": SubAgentSource } | "unknown";
