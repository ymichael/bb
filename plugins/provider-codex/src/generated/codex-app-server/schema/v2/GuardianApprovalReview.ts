
import type { GuardianApprovalReviewStatus } from "./GuardianApprovalReviewStatus.js";
import type { GuardianRiskLevel } from "./GuardianRiskLevel.js";
import type { GuardianUserAuthorization } from "./GuardianUserAuthorization.js";

export type GuardianApprovalReview = { status: GuardianApprovalReviewStatus, riskLevel: GuardianRiskLevel | null, userAuthorization: GuardianUserAuthorization | null, rationale: string | null, };
