import type {
  GitHostPullRequest,
  GitHostPullRequestCheck,
  ThreadPullRequest,
  ThreadPullRequestAttentionState,
  ThreadPullRequestChecks,
  ThreadPullRequestChecksState,
  ThreadPullRequestMergeability,
  ThreadPullRequestMergeabilityState,
  ThreadPullRequestReview,
  ThreadPullRequestReviewState,
} from "@bb/domain";

function isSameOrLaterCheck(
  candidate: GitHostPullRequestCheck,
  current: GitHostPullRequestCheck,
): boolean {
  if (candidate.startedAt === null) {
    return current.startedAt === null;
  }
  if (current.startedAt === null) {
    return true;
  }
  return Date.parse(candidate.startedAt) >= Date.parse(current.startedAt);
}

function assembleThreadPullRequestChecks(
  rawChecks: readonly GitHostPullRequestCheck[],
): ThreadPullRequestChecks {
  const latestChecksByName = new Map<string, GitHostPullRequestCheck>();
  for (const check of rawChecks) {
    const current = latestChecksByName.get(check.name);
    if (!current || isSameOrLaterCheck(check, current)) {
      latestChecksByName.set(check.name, check);
    }
  }
  const checks = [...latestChecksByName.values()];

  let passedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let unknownCount = 0;

  for (const check of checks) {
    if (check.status === "queued" || check.status === "in_progress") {
      pendingCount += 1;
      continue;
    }
    switch (check.conclusion) {
      case "success":
      case "skipped":
      case "neutral":
        passedCount += 1;
        break;
      case "failure":
      case "cancelled":
      case "timed_out":
      case "action_required":
      case "startup_failure":
      case "stale":
        failedCount += 1;
        break;
      case "unknown":
      case null:
        unknownCount += 1;
        break;
    }
  }

  let state: ThreadPullRequestChecksState;
  if (checks.length === 0) {
    state = "no_checks";
  } else if (failedCount > 0) {
    state = "failing";
  } else if (pendingCount > 0) {
    state = "pending";
  } else if (unknownCount > 0) {
    state = "unknown";
  } else {
    state = "passing";
  }

  return {
    state,
    totalCount: checks.length,
    passedCount,
    failedCount,
    pendingCount,
  };
}

function assembleThreadPullRequestReview(
  raw: GitHostPullRequest,
): ThreadPullRequestReview {
  let state: ThreadPullRequestReviewState;
  switch (raw.reviewDecision) {
    case "APPROVED":
      state = "approved";
      break;
    case "CHANGES_REQUESTED":
      state = "changes_requested";
      break;
    case "REVIEW_REQUIRED":
      state =
        raw.reviewRequestCount > 0 ? "review_requested" : "review_required";
      break;
    case null:
      state = raw.reviewRequestCount > 0 ? "review_requested" : "none";
      break;
  }

  return {
    state,
    reviewRequestCount: raw.reviewRequestCount,
  };
}

function assembleThreadPullRequestMergeability(
  raw: GitHostPullRequest,
): ThreadPullRequestMergeability {
  let state: ThreadPullRequestMergeabilityState;
  if (raw.state === "OPEN" && raw.isDraft) {
    state = "draft";
  } else if (
    raw.mergeable === "CONFLICTING" ||
    raw.mergeStateStatus === "DIRTY"
  ) {
    state = "conflicts";
  } else if (
    raw.mergeStateStatus === "BLOCKED" ||
    raw.mergeStateStatus === "BEHIND" ||
    raw.mergeStateStatus === "HAS_HOOKS"
  ) {
    state = "blocked";
  } else if (
    raw.mergeable === "MERGEABLE" ||
    raw.mergeStateStatus === "CLEAN"
  ) {
    state = "mergeable";
  } else {
    state = "unknown";
  }

  return {
    state,
    mergeStateStatus: raw.mergeStateStatus,
    mergeable: raw.mergeable,
  };
}

function assemblePullRequestAttention(
  state: ThreadPullRequest["state"],
  checks: ThreadPullRequestChecks,
  review: ThreadPullRequestReview,
  mergeability: ThreadPullRequestMergeability,
): ThreadPullRequestAttentionState {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  if (mergeability.state === "conflicts") return "conflicts";
  if (checks.state === "failing") return "checks_failed";
  if (review.state === "changes_requested") return "changes_requested";
  if (mergeability.state === "blocked") return "blocked";
  if (state === "draft") return "draft";
  if (
    review.state === "review_requested" ||
    review.state === "review_required"
  ) {
    return "review_requested";
  }
  if (checks.state === "pending") return "checks_pending";
  if (mergeability.state === "mergeable" && checks.state === "passing") {
    return "ready_to_merge";
  }
  return "none";
}

export function assembleThreadPullRequest(
  raw: GitHostPullRequest,
): ThreadPullRequest {
  const state =
    raw.state === "MERGED"
      ? "merged"
      : raw.state === "CLOSED"
        ? "closed"
        : raw.isDraft
          ? "draft"
          : "open";
  const checks = assembleThreadPullRequestChecks(raw.checks);
  const review = assembleThreadPullRequestReview(raw);
  const mergeability = assembleThreadPullRequestMergeability(raw);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    updatedAt: raw.updatedAt,
    checks,
    review,
    mergeability,
    attention: assemblePullRequestAttention(
      state,
      checks,
      review,
      mergeability,
    ),
  };
}
