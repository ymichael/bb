import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import { environments, threads } from "../../src/schema.js";
import {
  applyEnvironmentLifecycleEvent,
  applyEnvironmentLifecycleEventInTransaction,
  createEnvironment,
  EnvironmentLifecycleEventNotAppliedError,
  getEnvironment,
  requireEnvironmentLifecycleEventApplied,
  type CreateEnvironmentInput,
} from "../../src/data/environments.js";
import {
  applyThreadLifecycleEvent,
  createThread,
  getThread,
  markThreadDeleted,
  requireThreadLifecycleEventApplied,
} from "../../src/data/threads.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { withWriteAfterFirstRead } from "../helpers/interleave.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const seedEnvironment = (
    input: Omit<
      CreateEnvironmentInput,
      "projectId" | "hostId" | "providerOwnsPath"
    >,
  ) =>
    createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      hostId: host.id,
      projectId: project.id,
      ...input,
    });
  return { db, host, project, seedEnvironment };
}

function spyNotifier(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifyProject: vi.fn(),
    notifySystem: vi.fn(),
  };
}

describe("applyEnvironmentLifecycleEvent", () => {
  it("applies a legal event, persists the row, and notifies", () => {
    const { db, seedEnvironment } = setup();
    const spy = spyNotifier();
    const environment = seedEnvironment({ status: "ready" });

    const outcome = applyEnvironmentLifecycleEvent(db, spy, {
      environmentId: environment.id,
      event: { type: "provision.requested" },
    });

    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.environment.status).toBe("provisioning");
      expect(outcome.changes).toEqual(["status-changed"]);
    }
    expect(getEnvironment(db, environment.id)?.status).toBe("provisioning");
    expect(spy.notifyEnvironment).toHaveBeenCalledExactlyOnceWith(
      environment.id,
      ["status-changed"],
    );
  });

  it("applies events inside an existing transaction", () => {
    const { db, seedEnvironment } = setup();
    const environment = seedEnvironment({ status: "provisioning" });

    const outcome = db.transaction((tx) =>
      applyEnvironmentLifecycleEventInTransaction(tx, {
        environmentId: environment.id,
        event: { type: "provision.succeeded" },
      }),
    );

    expect(outcome.applied).toBe(true);
    expect(getEnvironment(db, environment.id)?.status).toBe("ready");
  });

  it("no-ops as illegal-transition and leaves the row untouched", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, seedEnvironment } = setup();
      const spy = spyNotifier();
      const environment = seedEnvironment({ status: "ready" });

      vi.setSystemTime(2_000);
      const outcome = applyEnvironmentLifecycleEvent(db, spy, {
        environmentId: environment.id,
        event: { type: "provision.succeeded" },
      });

      expect(outcome).toEqual({
        applied: false,
        detail: "no transition for provision.succeeded from status ready",
        reason: "illegal-transition",
      });
      expect(getEnvironment(db, environment.id)).toEqual(environment);
      expect(spy.notifyEnvironment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-ops as not-found for a missing environment", () => {
    const { db } = setup();
    const outcome = applyEnvironmentLifecycleEvent(db, noopNotifier, {
      environmentId: "env_nonexistent",
      event: { type: "provision.requested" },
    });
    expect(outcome).toEqual({
      applied: false,
      detail: "environment not found: env_nonexistent",
      reason: "not-found",
    });
  });

  it("no-ops the second of two sequential destroy records once the first applied", () => {
    const { db, seedEnvironment } = setup();
    const environment = seedEnvironment({
      path: "/tmp/double-destroy",
      status: "ready",
    });

    const first = applyEnvironmentLifecycleEvent(db, noopNotifier, {
      environmentId: environment.id,
      event: { type: "destroy.recorded" },
    });
    const second = applyEnvironmentLifecycleEvent(db, noopNotifier, {
      environmentId: environment.id,
      event: { type: "destroy.recorded" },
    });

    expect(first.applied).toBe(true);
    expect(second).toEqual({
      applied: false,
      detail: "no transition for destroy.recorded from status destroyed",
      reason: "illegal-transition",
    });
    expect(getEnvironment(db, environment.id)?.status).toBe("destroyed");
  });

  it("no-ops as cas-conflict when the status changes between load and update", () => {
    const { db, seedEnvironment } = setup();
    const environment = seedEnvironment({ status: "ready" });

    const outcome = db.transaction((tx: DbTransaction) => {
      const interleaved = withWriteAfterFirstRead(tx, () => {
        tx.update(environments)
          .set({ status: "error" })
          .where(eq(environments.id, environment.id))
          .run();
      });
      return applyEnvironmentLifecycleEventInTransaction(interleaved, {
        environmentId: environment.id,
        event: { type: "provision.requested" },
      });
    });

    expect(outcome).toEqual({
      applied: false,
      detail: "state changed while applying provision.requested from status ready",
      reason: "cas-conflict",
    });
    expect(getEnvironment(db, environment.id)?.status).toBe("error");
  });

  it("refuses a destroy record while a live or stopping thread holds the environment, then clears the path", () => {
    const { db, project, seedEnvironment } = setup();
    const spy = spyNotifier();
    const environment = seedEnvironment({
      path: "/tmp/destroy-claim",
      status: "ready",
    });
    const thread = createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
    });

    const blocked = applyEnvironmentLifecycleEvent(db, spy, {
      environmentId: environment.id,
      event: { type: "destroy.recorded" },
    });
    expect(blocked).toEqual({
      applied: false,
      detail: "state changed while applying destroy.recorded from status ready",
      reason: "cas-conflict",
    });
    expect(getEnvironment(db, environment.id)?.status).toBe("ready");

    requireThreadLifecycleEventApplied(
      applyThreadLifecycleEvent(db, {
        event: { type: "stop.requested" },
        threadId: thread.id,
      }),
    );
    expect(getThread(db, thread.id)?.status).toBe("stopping");
    markThreadDeleted(db, noopNotifier, { threadId: thread.id });
    const blockedByStop = applyEnvironmentLifecycleEvent(db, spy, {
      environmentId: environment.id,
      event: { type: "destroy.recorded" },
    });
    expect(blockedByStop.applied).toBe(false);

    db.delete(threads).where(eq(threads.id, thread.id)).run();
    const recorded = applyEnvironmentLifecycleEvent(db, spy, {
      environmentId: environment.id,
      event: { type: "destroy.recorded" },
    });
    expect(recorded.applied).toBe(true);
    expect(getEnvironment(db, environment.id)).toMatchObject({
      path: null,
      status: "destroyed",
    });
    expect(spy.notifyEnvironment).toHaveBeenCalledExactlyOnceWith(
      environment.id,
      ["status-changed"],
    );
  });
});

describe("requireEnvironmentLifecycleEventApplied", () => {
  it("returns the updated environment when applied", () => {
    const { db, seedEnvironment } = setup();
    const environment = seedEnvironment({ status: "error" });

    const updated = requireEnvironmentLifecycleEventApplied(
      applyEnvironmentLifecycleEvent(db, noopNotifier, {
        environmentId: environment.id,
        event: { type: "provision.requested" },
      }),
    );
    expect(updated.status).toBe("provisioning");
  });

  it("throws a typed error carrying reason and detail on a no-op", () => {
    const { db, seedEnvironment } = setup();
    const environment = seedEnvironment({ status: "ready" });

    const outcome = applyEnvironmentLifecycleEvent(db, noopNotifier, {
      environmentId: environment.id,
      event: { type: "provision.succeeded" },
    });
    let caught: EnvironmentLifecycleEventNotAppliedError | null = null;
    try {
      requireEnvironmentLifecycleEventApplied(outcome);
    } catch (error) {
      if (error instanceof EnvironmentLifecycleEventNotAppliedError) {
        caught = error;
      }
    }
    expect(caught?.reason).toBe("illegal-transition");
    expect(caught?.detail).toBe(
      "no transition for provision.succeeded from status ready",
    );
  });
});
