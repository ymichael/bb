
import type { AuthMode } from "../AuthMode.js";
import type { PlanType } from "../PlanType.js";

export type AccountUpdatedNotification = { authMode: AuthMode | null, planType: PlanType | null, };
