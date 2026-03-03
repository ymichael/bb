import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@beanbag/agent-core";
import { evaluateThreadOperationPolicy } from "../thread-operation-policy.js";

describe("evaluateThreadOperationPolicy", () => {
  it("allows promote only for idle, non-archived threads", () => {
    const statuses: ThreadStatus[] = [
      "created",
      "provisioning",
      "provisioning_failed",
      "idle",
      "active",
    ];

    for (const status of statuses) {
      const decision = evaluateThreadOperationPolicy("promote", {
        status,
        archived: false,
        primaryCheckoutActive: false,
      });
      if (status === "idle") {
        expect(decision.allowed).toBe(true);
      } else {
        expect(decision.allowed).toBe(false);
      }
    }
  });

  it("blocks all operations for archived threads", () => {
    const actions = ["promote", "demote", "commit-intent", "squash-intent"] as const;
    for (const action of actions) {
      const decision = evaluateThreadOperationPolicy(action, {
        status: "idle",
        archived: true,
        primaryCheckoutActive: false,
      });
      expect(decision.allowed).toBe(false);
    }
  });

  it("dispatches commit/squash intents immediately for idle and queues for active", () => {
    const commitIdle = evaluateThreadOperationPolicy("commit-intent", {
      status: "idle",
      archived: false,
      primaryCheckoutActive: false,
    });
    const commitActive = evaluateThreadOperationPolicy("commit-intent", {
      status: "active",
      archived: false,
      primaryCheckoutActive: false,
    });
    const squashIdle = evaluateThreadOperationPolicy("squash-intent", {
      status: "idle",
      archived: false,
      primaryCheckoutActive: false,
    });
    const squashActive = evaluateThreadOperationPolicy("squash-intent", {
      status: "active",
      archived: false,
      primaryCheckoutActive: false,
    });

    expect(commitIdle).toMatchObject({ allowed: true, dispatchMode: "immediate" });
    expect(commitActive).toMatchObject({ allowed: true, dispatchMode: "queued" });
    expect(squashIdle).toMatchObject({ allowed: true, dispatchMode: "immediate" });
    expect(squashActive).toMatchObject({ allowed: true, dispatchMode: "queued" });
  });

  it("requires demotion before commit/squash intents when the thread is promoted", () => {
    const commitDecision = evaluateThreadOperationPolicy("commit-intent", {
      status: "idle",
      archived: false,
      primaryCheckoutActive: true,
    });
    const squashDecision = evaluateThreadOperationPolicy("squash-intent", {
      status: "active",
      archived: false,
      primaryCheckoutActive: true,
    });

    expect(commitDecision.requiresDemoteFirst).toBe(true);
    expect(squashDecision.requiresDemoteFirst).toBe(true);
  });

  it("blocks commit/squash intents for non-runnable provisioning statuses", () => {
    const statuses: ThreadStatus[] = ["created", "provisioning", "provisioning_failed"];
    for (const status of statuses) {
      const commitDecision = evaluateThreadOperationPolicy("commit-intent", {
        status,
        archived: false,
        primaryCheckoutActive: false,
      });
      const squashDecision = evaluateThreadOperationPolicy("squash-intent", {
        status,
        archived: false,
        primaryCheckoutActive: false,
      });
      expect(commitDecision.allowed).toBe(false);
      expect(squashDecision.allowed).toBe(false);
    }
  });
});
