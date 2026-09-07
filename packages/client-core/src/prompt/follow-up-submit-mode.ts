export type FollowUpBlockedReason =
  | "loading-execution-options"
  | "loading-pending-interactions"
  | "pending-interaction"
  | "provisioning"
  | "stopping"
  | "unavailable";

export type FollowUpSubmitMode =
  | { kind: "ready" }
  | { kind: "queue"; onStop: () => void }
  | { kind: "stop-only"; onStop: () => void }
  | { kind: "blocked"; reason: FollowUpBlockedReason };
