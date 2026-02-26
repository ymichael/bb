import type { ThreadStatus } from "@beanbag/agent-core";
import { createMachine, initialTransition, transition } from "xstate";

type ThreadStatusTransitionEvent = {
  type: ThreadStatus;
};

// Single source of truth for persisted thread lifecycle transitions.
const THREAD_STATUS_STATES = {
  created: {
    on: {
      provisioning: "provisioning",
      provisioning_failed: "provisioning_failed",
      idle: "idle",
    },
  },
  provisioning: {
    on: {
      active: "active",
      idle: "idle",
      provisioning_failed: "provisioning_failed",
    },
  },
  provisioning_failed: {
    on: {
      provisioning: "provisioning",
      idle: "idle",
    },
  },
  idle: {
    on: {
      active: "active",
      provisioning: "provisioning",
    },
  },
  active: {
    on: {
      idle: "idle",
    },
  },
} as const;

function createThreadStatusMachine(initial: ThreadStatus) {
  return createMachine({
    id: "thread-status",
    types: {} as {
      context: Record<string, never>;
      events: ThreadStatusTransitionEvent;
    },
    context: {},
    initial,
    states: THREAD_STATUS_STATES,
  });
}

export function canTransitionThreadStatus(
  currentStatus: ThreadStatus,
  nextStatus: ThreadStatus,
): boolean {
  if (currentStatus === nextStatus) return true;

  const machine = createThreadStatusMachine(currentStatus);
  const [snapshot] = initialTransition(machine);
  const [nextSnapshot] = transition(machine, snapshot, { type: nextStatus });
  return nextSnapshot.value === nextStatus;
}
