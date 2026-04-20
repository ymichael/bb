import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireProjectId,
  requireThreadId,
  requireThreadIdWithLabelOrSelf,
  resolveContextSnapshot,
  resolveProjectId,
  resolveThreadId,
} from "../context-env.js";

describe("context-env", () => {
  beforeEach(() => {
    vi.stubEnv("BB_PROJECT_ID", undefined);
    vi.stubEnv("BB_THREAD_ID", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    vi.stubEnv("BB_PROJECT_ID", "proj-env");
    vi.stubEnv("BB_THREAD_ID", "thread-env");

    expect(resolveProjectId(undefined)).toBe("proj-env");
    expect(resolveThreadId(undefined)).toBe("thread-env");
  });

  it("normalizes empty values as undefined", () => {
    vi.stubEnv("BB_PROJECT_ID", "");
    vi.stubEnv("BB_THREAD_ID", "   ");

    expect(resolveProjectId(undefined)).toBeUndefined();
    expect(resolveThreadId(undefined)).toBeUndefined();
  });

  it("captures a consistent context snapshot", () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    vi.stubEnv("BB_THREAD_ID", "thread-1");

    const snapshot = resolveContextSnapshot();
    expect(snapshot.projectId).toBe("proj-1");
    expect(snapshot.threadId).toBe("thread-1");
    expect(snapshot.serverUrl).toMatch(/^https?:\/\//);
  });

  it("resolves --self from BB_THREAD_ID for read-only thread commands", () => {
    vi.stubEnv("BB_THREAD_ID", "thread-self");

    expect(requireThreadIdWithLabelOrSelf(undefined, { self: true })).toEqual({
      id: "thread-self",
      source: "self",
    });
  });

  it("rejects combining a thread id with --self for read-only thread commands", () => {
    vi.stubEnv("BB_THREAD_ID", "thread-self");

    expect(() =>
      requireThreadIdWithLabelOrSelf("thread-explicit", { self: true }),
    ).toThrow("Cannot combine a thread ID argument with --self.");
  });
});
