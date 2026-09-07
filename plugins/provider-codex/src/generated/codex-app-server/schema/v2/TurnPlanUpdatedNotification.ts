
import type { TurnPlanStep } from "./TurnPlanStep.js";

export type TurnPlanUpdatedNotification = { threadId: string, turnId: string, explanation: string | null, plan: Array<TurnPlanStep>, };
