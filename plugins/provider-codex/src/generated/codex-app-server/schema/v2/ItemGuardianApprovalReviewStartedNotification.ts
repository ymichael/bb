
import type { GuardianApprovalReview } from "./GuardianApprovalReview.js";
import type { GuardianApprovalReviewAction } from "./GuardianApprovalReviewAction.js";

export type ItemGuardianApprovalReviewStartedNotification = { threadId: string, turnId: string,
startedAtMs: number,
reviewId: string,
targetItemId: string | null, review: GuardianApprovalReview, action: GuardianApprovalReviewAction, };
