import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_URL,
  requireTaskId,
  requireThreadId,
  resolveDaemonUrl,
  requireProjectId,
  resolveProjectId,
  resolveTaskId,
  resolveThreadId,
} from "../context-env.js";

const CONTEXT_KEYS = [
  "BB_PROJECT_ID",
  "BB_TASK_ID",
  "BB_THREAD_ID",
  "BB_DAEMON_URL",
] as const;

afterEach(() => {
  for (const key of CONTEXT_KEYS) {
    delete process.env[key];
  }
});

describe("context env resolution", () => {
  it("prefers explicit project flag over env", () => {
    process.env.BB_PROJECT_ID = "proj-env";
    expect(resolveProjectId("proj-flag")).toBe("proj-flag");
  });

  it("uses BB_PROJECT_ID when project flag is missing", () => {
    process.env.BB_PROJECT_ID = "proj-env";
    expect(resolveProjectId(undefined)).toBe("proj-env");
  });

  it("requires a project value from flag or BB_PROJECT_ID", () => {
    expect(() => requireProjectId(undefined)).toThrow(
      "Missing project context. Pass a project ID (for example --project <id>) or set BB_PROJECT_ID.",
    );
  });

  it("requires task and thread values from explicit args or BB_* context", () => {
    expect(() => requireTaskId(undefined)).toThrow(
      "Missing task context. Pass <taskId> or set BB_TASK_ID.",
    );
    expect(() => requireThreadId(undefined)).toThrow(
      "Missing thread context. Pass <threadId> or set BB_THREAD_ID.",
    );
  });

  it("reads BB_TASK_ID and BB_THREAD_ID defaults", () => {
    process.env.BB_TASK_ID = "task-env";
    process.env.BB_THREAD_ID = "thread-env";

    expect(resolveTaskId(undefined)).toBe("task-env");
    expect(resolveThreadId(undefined)).toBe("thread-env");
  });

  it("treats blank values as unset", () => {
    process.env.BB_PROJECT_ID = "   ";
    process.env.BB_TASK_ID = "";
    process.env.BB_THREAD_ID = " \t ";
    process.env.BB_DAEMON_URL = " ";

    expect(resolveProjectId(undefined)).toBeUndefined();
    expect(resolveTaskId(undefined)).toBeUndefined();
    expect(resolveThreadId(undefined)).toBeUndefined();
    expect(resolveDaemonUrl()).toBe(DEFAULT_DAEMON_URL);
  });

  it("uses BB_DAEMON_URL when set", () => {
    process.env.BB_DAEMON_URL = "http://127.0.0.1:4444";
    expect(resolveDaemonUrl()).toBe("http://127.0.0.1:4444");
  });
});
