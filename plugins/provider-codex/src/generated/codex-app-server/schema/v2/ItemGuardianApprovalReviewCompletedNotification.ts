
import type { AutoReviewDecisionSource } from "./AutoReviewDecisionSource.js";
import type { GuardianApprovalReview } from "./GuardianApprovalReview.js";
import type { GuardianApprovalReviewAction } from "./GuardianApprovalReviewAction.js";

export type ItemGuardianApprovalReviewCompletedNotification = { threadId: string, turnId: string,
startedAtMs: number,
completedAtMs: number,
reviewId: string,
targetItemId: string | null, decisionSource: AutoReviewDecisionSource, review: GuardianApprovalReview, action: GuardianApprovalReviewAction, };
