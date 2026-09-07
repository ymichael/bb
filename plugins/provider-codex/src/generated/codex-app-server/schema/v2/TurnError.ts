
import type { CodexErrorInfo } from "./CodexErrorInfo.js";

export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null, };
