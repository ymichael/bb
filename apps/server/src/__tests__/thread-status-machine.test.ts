import type { ThreadStatus } from "@bb/core";
import { describe, expect, it } from "vitest";
import { canTransitionThreadStatus } from "../thread-status-machine.js";

const STATUSES: ThreadStatus[] = [
  "created",
  "provisioning",
  "provisioned",
  "provisioning_failed",
  "error",
  "idle",
  "active",
];

const ALLOWED_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  created: ["provisioning", "provisioning_failed", "idle"],
  provisioning: ["provisioned", "active", "idle", "provisioning_failed"],
  provisioned: ["active", "idle", "provisioning_failed"],
  provisioning_failed: ["provisioning", "provisioned", "idle"],
  error: ["active", "provisioning", "provisioned", "idle"],
  idle: ["active", "error", "provisioning", "provisioned"],
  active: ["error", "idle"],
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
