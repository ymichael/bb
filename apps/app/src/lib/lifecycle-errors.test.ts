import { describe, expect, it } from "vitest";
import type { LifecycleApiError } from "@bb/server-contract";
import { HttpError } from "./api";
import {
  describeLifecycleError,
  formatLifecycleErrorDescription,
  parseLifecycleError,
  type LifecycleErrorDescription,
  type LifecycleErrorOperation,
} from "./lifecycle-errors";

interface DescriptionCase {
  body: LifecycleApiError;
  expected: LifecycleErrorDescription;
  name: string;
  operation?: LifecycleErrorOperation;
}

function httpError(body: LifecycleApiError): HttpError {
  return new HttpError({
    body,
    code: body.code,
    message: body.message,
    status: 409,
  });
}

const descriptionCases: DescriptionCase[] = [
  {
    name: "environment_not_ready provisioning",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "provisioning",
        hasPath: false,
      },
    },
    expected: {
      title: "Workspace starting",
      body: "Workspace is still starting.",
      severity: "info",
    },
  },
  {
    name: "environment_not_ready ready without path",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "ready",
        hasPath: false,
      },
    },
    expected: {
      title: "Workspace unavailable",
      body: "Workspace is unavailable.",
      severity: "warning",
    },
  },
  {
    name: "environment_not_ready ready with path",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "ready",
        hasPath: true,
      },
    },
    expected: {
      title: "Workspace unavailable",
      body: "Workspace is unavailable.",
      severity: "warning",
    },
  },
  {
    name: "environment_not_ready error",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "error",
        hasPath: false,
      },
    },
    expected: {
      title: "Workspace setup failed",
      body: "Workspace setup failed.",
      severity: "error",
    },
  },
  {
    name: "environment_not_ready retiring",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "retiring",
        hasPath: true,
      },
    },
    expected: {
      title: "Workspace cleaning up",
      body: "Workspace is being cleaned up.",
      severity: "info",
    },
  },
  {
    name: "environment_not_ready destroying",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "destroying",
        hasPath: true,
      },
    },
    expected: {
      title: "Workspace cleaning up",
      body: "Workspace is being cleaned up.",
      severity: "info",
    },
  },
  {
    name: "environment_not_ready destroyed archived thread",
    body: {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "destroyed",
        hasPath: false,
      },
    },
    expected: {
      title: "Workspace unavailable",
      body: "Workspace no longer exists.",
      severity: "warning",
    },
  },
  {
    name: "thread_environment_unavailable never attached",
    body: {
      code: "thread_environment_unavailable",
      message: "Thread environment is unavailable",
      details: {
        environmentStatus: null,
        reason: "never_attached",
      },
    },
    expected: {
      title: "Workspace unavailable",
      body: "Workspace is not available yet.",
      severity: "info",
    },
  },
  {
    name: "thread_environment_unavailable destroyed",
    body: {
      code: "thread_environment_unavailable",
      message: "Thread environment is unavailable",
      details: {
        environmentStatus: "destroyed",
        reason: "destroyed",
      },
    },
    expected: {
      title: "Workspace unavailable",
      body: "Workspace no longer exists.",
      severity: "warning",
    },
  },
  {
    name: "thread_environment_unavailable destroying",
    body: {
      code: "thread_environment_unavailable",
      message: "Thread environment is unavailable",
      details: {
        environmentStatus: "destroying",
        reason: "destroying",
      },
    },
    expected: {
      title: "Workspace cleaning up",
      body: "Workspace is being cleaned up.",
      severity: "info",
    },
  },
  {
    name: "thread_environment_unavailable provisioning",
    body: {
      code: "thread_environment_unavailable",
      message: "Thread environment is unavailable",
      details: {
        environmentStatus: "provisioning",
        reason: "provisioning",
      },
    },
    expected: {
      title: "Workspace starting",
      body: "Workspace is still starting.",
      severity: "info",
    },
  },
  {
    name: "thread_environment_unavailable errored",
    body: {
      code: "thread_environment_unavailable",
      message: "Thread environment is unavailable",
      details: {
        environmentStatus: "error",
        reason: "errored",
      },
    },
    expected: {
      title: "Workspace setup failed",
      body: "Workspace setup failed.",
      severity: "error",
    },
  },
  {
    name: "thread_not_writable archived",
    body: {
      code: "thread_not_writable",
      message: "Thread is archived",
      details: {
        archivedAt: 10,
        reason: "archived",
        threadStatus: "idle",
      },
    },
    expected: {
      title: "Thread archived",
      body: "Unarchive the thread first.",
      severity: "info",
    },
  },
  {
    name: "thread_not_writable stopping",
    body: {
      code: "thread_not_writable",
      message: "Thread is stopping",
      details: {
        archivedAt: null,
        reason: "stopping",
        threadStatus: "stopping",
      },
    },
    expected: {
      title: "Thread stopping",
      body: "The thread is stopping.",
      severity: "warning",
    },
  },
  {
    name: "thread_not_writable deleted",
    body: {
      code: "thread_not_writable",
      message: "Thread is deleted",
      details: {
        archivedAt: null,
        reason: "deleted",
        threadStatus: "idle",
      },
    },
    expected: {
      title: "Thread deleted",
      body: "This thread was deleted.",
      severity: "error",
    },
  },
  {
    name: "thread_not_writable not started while starting",
    body: {
      code: "thread_not_writable",
      message: "Thread is not active",
      details: {
        archivedAt: null,
        reason: "not_started",
        threadStatus: "starting",
      },
    },
    expected: {
      title: "Thread starting",
      body: "The thread is still starting.",
      severity: "info",
    },
  },
  {
    name: "thread_not_writable not active",
    body: {
      code: "thread_not_writable",
      message: "Thread is not active",
      details: {
        archivedAt: null,
        reason: "not_active",
        threadStatus: "idle",
      },
    },
    expected: {
      title: "Thread not running",
      body: "The thread is not running.",
      severity: "warning",
    },
  },
  {
    name: "thread_not_writable errored",
    body: {
      code: "thread_not_writable",
      message: "Thread errored",
      details: {
        archivedAt: null,
        reason: "errored",
        threadStatus: "error",
      },
    },
    expected: {
      title: "Thread failed",
      body: "This thread failed and cannot continue.",
      severity: "error",
    },
  },
  {
    name: "thread_not_writable already active",
    body: {
      code: "thread_not_writable",
      message: "Thread already active",
      details: {
        archivedAt: null,
        reason: "already_active",
        threadStatus: "active",
      },
    },
    expected: {
      title: "Thread already running",
      body: "The thread is already running.",
      severity: "warning",
    },
  },
  {
    name: "thread_not_writable still starting",
    body: {
      code: "thread_not_writable",
      message: "Thread is still starting",
      details: {
        archivedAt: null,
        reason: "still_starting",
        threadStatus: "starting",
      },
    },
    expected: {
      title: "Thread starting",
      body: "The thread is still starting.",
      severity: "info",
    },
  },
  {
    name: "host_unavailable suspended",
    body: {
      code: "host_unavailable",
      message: "Host is suspended",
      details: {
        destroyedAt: null,
        hostStatus: "disconnected",
        reason: "suspended",
        suspendedAt: 10,
      },
    },
    expected: {
      title: "Host paused",
      body: "Host is paused.",
      severity: "warning",
    },
  },
  {
    name: "host_unavailable disconnected",
    body: {
      code: "host_unavailable",
      message: "Host disconnected",
      details: {
        destroyedAt: null,
        hostStatus: "disconnected",
        reason: "disconnected",
        suspendedAt: null,
      },
    },
    expected: {
      title: "Host offline",
      body: "Host is offline.",
      severity: "warning",
    },
  },
  {
    name: "host_unavailable destroyed",
    body: {
      code: "host_unavailable",
      message: "Host removed",
      details: {
        destroyedAt: 10,
        hostStatus: null,
        reason: "destroyed",
        suspendedAt: null,
      },
    },
    expected: {
      title: "Host removed",
      body: "Host was removed.",
      severity: "error",
    },
  },
  {
    name: "project_unavailable pending deletion",
    body: {
      code: "project_unavailable",
      message: "Project unavailable",
      details: {
        deletedAt: null,
        reason: "pending_deletion",
      },
    },
    expected: {
      title: "Project deletion in progress",
      body: "This project is being deleted.",
      severity: "info",
    },
  },
  {
    name: "project_unavailable deleted",
    body: {
      code: "project_unavailable",
      message: "Project unavailable",
      details: {
        deletedAt: 10,
        reason: "deleted",
      },
    },
    expected: {
      title: "Project deleted",
      body: "This project was deleted.",
      severity: "error",
    },
  },
  {
    name: "parent_thread_invalid not found",
    body: {
      code: "parent_thread_invalid",
      message: "Parent thread is invalid",
      details: {
        reason: "not_found",
        subject: "parent",
      },
    },
    expected: {
      title: "Parent thread unavailable",
      body: "That parent thread no longer exists.",
      severity: "error",
    },
  },
  {
    name: "parent_thread_invalid archived",
    body: {
      code: "parent_thread_invalid",
      message: "Parent thread is invalid",
      details: {
        reason: "archived",
        subject: "parent",
      },
    },
    expected: {
      title: "Parent thread unavailable",
      body: "Unarchive the parent thread first or choose another parent.",
      severity: "warning",
    },
  },
  {
    name: "parent_thread_invalid deleted",
    body: {
      code: "parent_thread_invalid",
      message: "Parent thread is invalid",
      details: {
        reason: "deleted",
        subject: "parent",
      },
    },
    expected: {
      title: "Parent thread unavailable",
      body: "That parent thread was deleted.",
      severity: "error",
    },
  },
  {
    name: "parent_thread_invalid self",
    body: {
      code: "parent_thread_invalid",
      message: "Parent thread is invalid",
      details: {
        reason: "self",
        subject: "parent",
      },
    },
    expected: {
      title: "Parent thread unavailable",
      body: "A thread cannot be its own parent.",
      severity: "error",
    },
  },
  {
    name: "parent_thread_invalid cycle",
    body: {
      code: "parent_thread_invalid",
      message: "Parent thread is invalid",
      details: {
        reason: "cycle",
        subject: "parent",
      },
    },
    expected: {
      title: "Parent thread unavailable",
      body: "Choose a thread that is not a child of this thread.",
      severity: "error",
    },
  },
  {
    name: "parent_thread_invalid too deep",
    body: {
      code: "parent_thread_invalid",
      message: "Parent thread is invalid",
      details: {
        reason: "too_deep",
        subject: "parent",
      },
    },
    expected: {
      title: "Parent thread unavailable",
      body: "Thread nesting is limited to 4 levels.",
      severity: "error",
    },
  },
  {
    name: "parent_thread_invalid sender",
    body: {
      code: "parent_thread_invalid",
      message: "Sender thread is invalid",
      details: {
        reason: "not_found",
        subject: "sender",
      },
    },
    expected: {
      title: "Sender thread unavailable",
      body: "The sender thread no longer exists.",
      severity: "error",
    },
  },
  {
    name: "dispatch_rejected shows the plugin's message verbatim",
    body: {
      code: "dispatch_rejected",
      message: "Sandbox quota is exhausted. Free a slot first.",
      details: {
        pluginId: "policy-guard",
      },
    },
    expected: {
      title: "Blocked by a plugin",
      body: 'Blocked by the "policy-guard" plugin: Sandbox quota is exhausted. Free a slot first.',
      severity: "warning",
    },
  },
  {
    name: "dispatch_hook_failed adds the recovery hint",
    body: {
      code: "dispatch_hook_failed",
      message:
        'The "policy-guard" plugin\'s message.dispatch hook failed: did not decide within 5000ms',
      details: {
        pluginId: "policy-guard",
      },
    },
    expected: {
      title: "Plugin dispatch hook failed",
      body: 'The "policy-guard" plugin\'s message.dispatch hook failed: did not decide within 5000ms. Disable that plugin to continue.',
      severity: "error",
    },
  },
];

describe("parseLifecycleError", () => {
  it("parses HttpError bodies that match the lifecycle union", () => {
    const body: LifecycleApiError = {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "provisioning",
        hasPath: false,
      },
    };

    expect(parseLifecycleError(httpError(body))).toEqual(body);
  });

  it("returns null for non-lifecycle errors", () => {
    const genericError = new HttpError({
      body: {
        code: "invalid_request",
        message: "Request failed",
      },
      code: "invalid_request",
      message: "Request failed",
      status: 400,
    });

    expect(parseLifecycleError(new Error("Nope"))).toBeNull();
    expect(parseLifecycleError(genericError)).toBeNull();
  });
});

describe("describeLifecycleError", () => {
  it.each(descriptionCases)("$name", ({ body, expected, operation }) => {
    expect(
      describeLifecycleError({
        error: httpError(body),
        operation,
      }),
    ).toEqual(expected);
  });

  it("uses operation titles while keeping lifecycle reason text", () => {
    const body: LifecycleApiError = {
      code: "environment_not_ready",
      message: "Environment unavailable",
      details: {
        environmentStatus: "destroyed",
        hasPath: false,
      },
    };

    expect(
      describeLifecycleError({
        error: httpError(body),
        operation: "load_diff",
      }),
    ).toEqual({
      title: "Failed to load diff",
      body: "Workspace no longer exists.",
      severity: "warning",
    });
  });

  it("formats lifecycle descriptions as a single action-oriented message", () => {
    expect(
      formatLifecycleErrorDescription({
        title: "Failed to send message",
        body: "The thread is still starting.",
        severity: "info",
      }),
    ).toBe("Failed to send message. The thread is still starting.");
  });

  it("returns null for non-lifecycle errors", () => {
    expect(
      describeLifecycleError({
        error: new Error("Failed"),
      }),
    ).toBeNull();
  });

  it("keeps a gate rejection readable under an operation title", () => {
    const pluginMessage = "This project is frozen until the release ships.";
    const body: LifecycleApiError = {
      code: "dispatch_rejected",
      message: pluginMessage,
      details: { pluginId: "release-freeze" },
    };

    const description = describeLifecycleError({
      error: httpError(body),
      operation: "send_message",
    });

    if (!description) {
      throw new Error("expected a lifecycle description");
    }
    expect(description.body).toContain(pluginMessage);
    expect(description.body).toContain('"release-freeze"');
    expect(formatLifecycleErrorDescription(description)).toBe(
      'Failed to send message. Blocked by the "release-freeze" plugin: This project is frozen until the release ships.',
    );
  });

  it("names the plugin once when a gate fails closed", () => {
    const body: LifecycleApiError = {
      code: "dispatch_hook_failed",
      message:
        'The "release-freeze" plugin\'s message.dispatch hook failed: handler threw',
      details: { pluginId: "release-freeze" },
    };

    const description = describeLifecycleError({
      error: httpError(body),
      operation: "queue_message",
    });

    if (!description) {
      throw new Error("expected a lifecycle description");
    }
    expect(description.body.match(/release-freeze/gu)).toHaveLength(1);
    expect(description.body).toContain("Disable that plugin to continue.");
  });
});
