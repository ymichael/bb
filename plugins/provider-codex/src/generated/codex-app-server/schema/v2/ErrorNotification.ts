
import type { TurnError } from "./TurnError.js";

export type ErrorNotification = { error: TurnError, willRetry: boolean, threadId: string, turnId: string, };
