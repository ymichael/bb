import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  assertValidParentThread,
  isAgentDelegatedChildThread,
  isParentNotifiableChildThread,
} from "../../src/services/threads/thread-parent.js";

type ThrowingCallback = () => void;

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: {
      hostId: host.id,
      path: "/tmp/thread-parent-test",
      type: "local_path",
    },
  });
  return { db, host, project };
}

function captureApiError(callback: ThrowingCallback): ApiError {
  try {
    callback();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected ApiError");
}

describe("thread parent validation", () => {
  it("accepts live standard parent threads", () => {
    const { db, project } = setup();
    const parentThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const validatedParent = assertValidParentThread(
      { db },
      {
        parentThreadId: parentThread.id,
      },
    );

    expect(validatedParent.id).toBe(parentThread.id);
  });

  it("accepts a live parent thread from another project", () => {
    const { db, host } = setup();
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: {
        hostId: host.id,
        path: "/tmp/thread-parent-test-other",
        type: "local_path",
      },
    });
    const parentThread = createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
    });

    const validatedParent = assertValidParentThread(
      { db },
      { parentThreadId: parentThread.id },
    );

    expect(validatedParent.projectId).toBe(otherProject.id);
  });

  it("rejects self-parenting", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const error = captureApiError(() => {
      assertValidParentThread(
        { db },
        {
          childThreadId: thread.id,
          parentThreadId: thread.id,
        },
      );
    });

    expect(error.body.details).toEqual({
      reason: "self",
      subject: "parent",
    });
  });

  it("rejects parent assignments that would create a cycle", () => {
    const { db, project } = setup();
    const rootThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const childThread = createThread(db, noopNotifier, {
      parentThreadId: rootThread.id,
      projectId: project.id,
      providerId: "codex",
    });
    const grandchildThread = createThread(db, noopNotifier, {
      parentThreadId: childThread.id,
      projectId: project.id,
      providerId: "codex",
    });

    const error = captureApiError(() => {
      assertValidParentThread(
        { db },
        {
          childThreadId: rootThread.id,
          parentThreadId: grandchildThread.id,
        },
      );
    });

    expect(error.body.details).toEqual({
      reason: "cycle",
      subject: "parent",
    });
  });

  it("allows nesting up to the configured depth cap", () => {
    const { db, project } = setup();
    const rootThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const level2Thread = createThread(db, noopNotifier, {
      parentThreadId: rootThread.id,
      projectId: project.id,
      providerId: "codex",
    });
    const level3Thread = createThread(db, noopNotifier, {
      parentThreadId: level2Thread.id,
      projectId: project.id,
      providerId: "codex",
    });

    const validatedParent = assertValidParentThread(
      { db },
      {
        parentThreadId: level3Thread.id,
      },
    );

    expect(validatedParent.id).toBe(level3Thread.id);
  });

  it("rejects new children beyond the configured depth cap", () => {
    const { db, project } = setup();
    const rootThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const level2Thread = createThread(db, noopNotifier, {
      parentThreadId: rootThread.id,
      projectId: project.id,
      providerId: "codex",
    });
    const level3Thread = createThread(db, noopNotifier, {
      parentThreadId: level2Thread.id,
      projectId: project.id,
      providerId: "codex",
    });
    const level4Thread = createThread(db, noopNotifier, {
      parentThreadId: level3Thread.id,
      projectId: project.id,
      providerId: "codex",
    });

    const error = captureApiError(() => {
      assertValidParentThread(
        { db },
        {
          parentThreadId: level4Thread.id,
        },
      );
    });

    expect(error.body.details).toEqual({
      reason: "too_deep",
      subject: "parent",
    });
  });

  it("rejects moves whose existing descendants would exceed the depth cap", () => {
    const { db, project } = setup();
    const rootThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const level2Thread = createThread(db, noopNotifier, {
      parentThreadId: rootThread.id,
      projectId: project.id,
      providerId: "codex",
    });
    const level3Thread = createThread(db, noopNotifier, {
      parentThreadId: level2Thread.id,
      projectId: project.id,
      providerId: "codex",
    });
    const movingThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    createThread(db, noopNotifier, {
      parentThreadId: movingThread.id,
      projectId: project.id,
      providerId: "codex",
    });

    const error = captureApiError(() => {
      assertValidParentThread(
        { db },
        {
          childThreadId: movingThread.id,
          parentThreadId: level3Thread.id,
        },
      );
    });

    expect(error.body.details).toEqual({
      reason: "too_deep",
      subject: "parent",
    });
  });
});

describe("isAgentDelegatedChildThread", () => {
  it("is true for a thread with a parent", () => {
    expect(
      isAgentDelegatedChildThread({
        parentThreadId: "thr_parent",
      }),
    ).toBe(true);
  });

  it("is false for a fork-style root", () => {
    expect(
      isAgentDelegatedChildThread({
        parentThreadId: null,
      }),
    ).toBe(false);
  });
});

describe("isParentNotifiableChildThread", () => {
  it("is true for a hidden delegated child", () => {
    expect(
      isParentNotifiableChildThread({
        originKind: null,
        parentThreadId: "thr_parent",
      }),
    ).toBe(true);
  });

  it("is false for a fork that kept a parent id", () => {
    expect(
      isParentNotifiableChildThread({
        originKind: "fork",
        parentThreadId: "thr_parent",
      }),
    ).toBe(false);
  });

  it("is false for a source-derived fork and for a root thread", () => {
    expect(
      isParentNotifiableChildThread({
        originKind: "fork",
        parentThreadId: "thr_parent",
      }),
    ).toBe(false);
    expect(
      isParentNotifiableChildThread({
        originKind: null,
        parentThreadId: null,
      }),
    ).toBe(false);
  });
});
