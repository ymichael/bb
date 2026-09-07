
import type { McpServerStartupFailureReason } from "./McpServerStartupFailureReason.js";
import type { McpServerStartupState } from "./McpServerStartupState.js";

export type McpServerStatusUpdatedNotification = { threadId: string | null, name: string, status: McpServerStartupState, error: string | null, failureReason: McpServerStartupFailureReason | null, };
