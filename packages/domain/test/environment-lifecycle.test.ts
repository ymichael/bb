import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_LIFECYCLE,
  evaluateEnvironmentLifecycleEvent,
  type EnvironmentLifecycleEvent,
  type EnvironmentLifecycleEventType,
  type EnvironmentLifecycleRowState,
} from "../src/environment-lifecycle.js";
import {
  environmentStatusValues,
  type EnvironmentStatus,
} from "../src/environment.js";

const allEventTypes: readonly EnvironmentLifecycleEventType[] = [
  "provision.requested",
  "provision.succeeded",
  "provision.failed",
  "provision.cancelled",
  "destroy.recorded",
];

function eventOfType(
  eventType: EnvironmentLifecycleEventType,
): EnvironmentLifecycleEvent {
  return { type: eventType };
}

function rowState(
  status: EnvironmentStatus,
  overrides?: Partial<Omit<EnvironmentLifecycleRowState, "status">>,
): EnvironmentLifecycleRowState {
  return {
    path: null,
    status,
    ...overrides,
  };
}

function expectedTarget(
  eventType: EnvironmentLifecycleEventType,
  status: EnvironmentStatus,
  row: EnvironmentLifecycleRowState,
): EnvironmentStatus | undefined {
  const target = ENVIRONMENT_LIFECYCLE[status][eventType];
  if (target === undefined || typeof target === "string") {
    return target;
  }
  return row.path !== null
    ? target.withWorkspacePath
    : target.withoutWorkspacePath;
}

describe("ENVIRONMENT_LIFECYCLE table", () => {
  it("covers every environment status", () => {
    expect(Object.keys(ENVIRONMENT_LIFECYCLE).sort()).toEqual(
      [...environmentStatusValues].sort(),
    );
  });

  it("matches the designed transitions exactly", () => {
    expect(ENVIRONMENT_LIFECYCLE).toEqual({
      provisioning: {
        "provision.succeeded": "ready",
        "provision.failed": "error",
        "provision.cancelled": {
          withWorkspacePath: "ready",
          withoutWorkspacePath: "destroyed",
        },
      },
      ready: {
        "provision.requested": "provisioning",
        "destroy.recorded": "destroyed",
      },
      error: {
        "provision.requested": "provisioning",
        "destroy.recorded": "destroyed",
      },
      destroyed: {},
    });
  });
});

describe("evaluateEnvironmentLifecycleEvent", () => {
  it("applies every table cell", () => {
    for (const status of environmentStatusValues) {
      for (const eventType of allEventTypes) {
        if (ENVIRONMENT_LIFECYCLE[status][eventType] === undefined) {
          continue;
        }
        const environment = rowState(status);
        expect(
          evaluateEnvironmentLifecycleEvent({
            environment,
            event: eventOfType(eventType),
          }),
        ).toEqual({ to: expectedTarget(eventType, status, environment) });
      }
    }
  });

  it("no-ops as illegal-transition for every absent cell", () => {
    for (const status of environmentStatusValues) {
      for (const eventType of allEventTypes) {
        if (ENVIRONMENT_LIFECYCLE[status][eventType] !== undefined) {
          continue;
        }
        expect(
          evaluateEnvironmentLifecycleEvent({
            environment: rowState(status),
            event: eventOfType(eventType),
          }),
        ).toEqual({
          noop: "illegal-transition",
          detail: `no transition for ${eventType} from status ${status}`,
        });
      }
    }
  });

  it("resolves path-dependent provision cancellation by workspace path", () => {
    expect(
      evaluateEnvironmentLifecycleEvent({
        environment: rowState("provisioning", { path: "/tmp/workspace" }),
        event: { type: "provision.cancelled" },
      }),
    ).toEqual({ to: "ready" });
    expect(
      evaluateEnvironmentLifecycleEvent({
        environment: rowState("provisioning"),
        event: { type: "provision.cancelled" },
      }),
    ).toEqual({ to: "destroyed" });
  });
});
