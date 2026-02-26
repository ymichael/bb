import type { ThreadStatus } from "@beanbag/agent-core";
import { describe, expect, it } from "vitest";
import { canTransitionThreadStatus } from "../thread-status-machine.js";

const STATUSES: ThreadStatus[] = [
  "created",
  "provisioning",
  "provisioning_failed",
  "idle",
  "active",
];

const ALLOWED_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  created: ["provisioning", "provisioning_failed", "idle"],
  provisioning: ["active", "idle", "provisioning_failed"],
  provisioning_failed: ["provisioning", "idle"],
  idle: ["active", "provisioning"],
  active: ["idle"],
};

describe("thread status machine", () => {
  for (const currentStatus of STATUSES) {
    for (const nextStatus of STATUSES) {
      const expected =
        currentStatus === nextStatus ||
        ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus);

      it(`${currentStatus} -> ${nextStatus} is ${expected ? "allowed" : "blocked"}`, () => {
        expect(canTransitionThreadStatus(currentStatus, nextStatus)).toBe(expected);
      });
    }
  }
});

