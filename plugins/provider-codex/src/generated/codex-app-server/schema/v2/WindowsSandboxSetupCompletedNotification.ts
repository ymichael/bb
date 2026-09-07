
import type { WindowsSandboxSetupMode } from "./WindowsSandboxSetupMode.js";

export type WindowsSandboxSetupCompletedNotification = { mode: WindowsSandboxSetupMode, success: boolean, error: string | null, };
