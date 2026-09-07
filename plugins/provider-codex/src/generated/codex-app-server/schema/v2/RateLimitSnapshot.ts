
import type { PlanType } from "../PlanType.js";
import type { CreditsSnapshot } from "./CreditsSnapshot.js";
import type { RateLimitReachedType } from "./RateLimitReachedType.js";
import type { RateLimitWindow } from "./RateLimitWindow.js";
import type { SpendControlLimitSnapshot } from "./SpendControlLimitSnapshot.js";

export type RateLimitSnapshot = { limitId: string | null, limitName: string | null, primary: RateLimitWindow | null, secondary: RateLimitWindow | null, credits: CreditsSnapshot | null, individualLimit: SpendControlLimitSnapshot | null,
spendControlReached: boolean | null, planType: PlanType | null, rateLimitReachedType: RateLimitReachedType | null, };
