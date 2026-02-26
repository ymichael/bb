import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_URL,
  requireProjectId,
  requireThreadId,
  resolveContextSnapshot,
  resolveDaemonUrl,
  resolveProjectId,
  resolveThreadId,
} from "../context-env.js";

const ENV_KEYS = ["BB_PROJECT_ID", "BB_THREAD_ID", "BB_DAEMON_URL"] as const;

describe("context-env", () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("resolves daemon url from env with fallback", () => {
    expect(resolveDaemonUrl()).toBe(DEFAULT_DAEMON_URL);
    process.env.BB_DAEMON_URL = "http://127.0.0.1:5555";
    expect(resolveDaemonUrl()).toBe("http://127.0.0.1:5555");
  });

  it("requires project and thread context when missing", () => {
    expect(() => requireProjectId(undefined)).toThrow(
      "Missing project context. Pass a project ID (for example --project <id>) or set BB_PROJECT_ID.",
    );
    expect(() => requireThreadId(undefined)).toThrow(
      "Missing thread context. Pass <threadId> or set BB_THREAD_ID.",
    );
  });

  it("reads BB_PROJECT_ID and BB_THREAD_ID defaults", () => {
    process.env.BB_PROJECT_ID = "proj-env";
    process.env.BB_THREAD_ID = "thread-env";

    expect(resolveProjectId(undefined)).toBe("proj-env");
    expect(resolveThreadId(undefined)).toBe("thread-env");
  });

  it("normalizes empty values as undefined", () => {
    process.env.BB_PROJECT_ID = "";
    process.env.BB_THREAD_ID = "   ";

    expect(resolveProjectId(undefined)).toBeUndefined();
    expect(resolveThreadId(undefined)).toBeUndefined();
  });

  it("captures a consistent context snapshot", () => {
    process.env.BB_PROJECT_ID = "proj-1";
    process.env.BB_THREAD_ID = "thread-1";
    process.env.BB_DAEMON_URL = "http://localhost:4444";

    expect(resolveContextSnapshot()).toEqual({
      projectId: "proj-1",
      threadId: "thread-1",
      daemonUrl: "http://localhost:4444",
      daemonUrlFromEnv: "http://localhost:4444",
    });
  });
});
