import {
  permissionEscalationValues,
  permissionModeValues,
  runtimePermissionPolicySchema,
  runtimePermissionScopeValues,
  threadTurnInitiatorSchema,
} from "@bb/domain";
import type { RuntimePermissionPolicy, ThreadTurnInitiator } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { resolvePermissionEscalation } from "../../src/services/threads/thread-runtime-config.js";

const EXPECTED_ESCALATION = {
  user: "ask",
  agent: "deny",
  system: "deny",
} satisfies Record<ThreadTurnInitiator, "ask" | "deny">;

const threadTurnInitiatorValues = threadTurnInitiatorSchema.options;

describe("permission escalation by turn initiator", () => {
  it("covers every initiator", () => {
    expect(threadTurnInitiatorValues).toEqual(["user", "agent", "system"]);
    expect(Object.keys(EXPECTED_ESCALATION)).toHaveLength(
      threadTurnInitiatorValues.length,
    );
  });

  it.each(threadTurnInitiatorValues.map((initiator) => [initiator] as const))(
    "%s",
    (initiator) => {
      expect(resolvePermissionEscalation({ initiator })).toBe(
        EXPECTED_ESCALATION[initiator],
      );
    },
  );
});

const approvalReviewerValues = ["user", "automatic"] as const;
type ReviewerFromPolicy = NonNullable<
  RuntimePermissionPolicy["approvalReviewer"]
>;
const reviewerValuesCoverUnion: [
  (typeof approvalReviewerValues)[number],
] extends [ReviewerFromPolicy]
  ? [ReviewerFromPolicy] extends [(typeof approvalReviewerValues)[number]]
    ? true
    : false
  : false = true;
void reviewerValuesCoverUnion;

const ESCALATION_INPUTS = [...permissionEscalationValues, null] as const;
const REVIEWER_INPUTS = [...approvalReviewerValues, null] as const;

type PolicyCell =
  `${(typeof permissionModeValues)[number]}|${(typeof runtimePermissionScopeValues)[number]}|${NonNullable<(typeof REVIEWER_INPUTS)[number]> | "-"}|${NonNullable<(typeof ESCALATION_INPUTS)[number]> | "-"}`;

const ACCEPTED_POLICY_SHAPES: readonly PolicyCell[] = [
  "accept-edits|workspace|user|ask",
  "accept-edits|workspace|user|deny",
  "auto|workspace|automatic|ask",
  "auto|workspace|automatic|deny",
  "full|full|-|-",
];

const POLICY_CELLS = permissionModeValues.flatMap((permissionMode) =>
  runtimePermissionScopeValues.flatMap((permissionScope) =>
    REVIEWER_INPUTS.flatMap((approvalReviewer) =>
      ESCALATION_INPUTS.map(
        (permissionEscalation) =>
          ({
            permissionMode,
            permissionScope,
            approvalReviewer,
            permissionEscalation,
          }) as const,
      ),
    ),
  ),
);

describe("runtime permission policy shapes", () => {
  it("enumerates the full cross product", () => {
    expect(permissionModeValues).toEqual(["accept-edits", "auto", "full"]);
    expect(runtimePermissionScopeValues).toEqual(["workspace", "full"]);
    expect(approvalReviewerValues).toEqual(["user", "automatic"]);
    expect(permissionEscalationValues).toEqual(["ask", "deny"]);
    expect(POLICY_CELLS).toHaveLength(3 * 2 * 3 * 3);
    expect(runtimePermissionPolicySchema.options).toHaveLength(3);
  });

  it.each(POLICY_CELLS)(
    "$permissionMode × $permissionScope × $approvalReviewer × $permissionEscalation",
    (cell) => {
      const key: PolicyCell = `${cell.permissionMode}|${cell.permissionScope}|${cell.approvalReviewer ?? "-"}|${cell.permissionEscalation ?? "-"}`;
      expect(runtimePermissionPolicySchema.safeParse(cell).success).toBe(
        ACCEPTED_POLICY_SHAPES.includes(key),
      );
    },
  );
});
