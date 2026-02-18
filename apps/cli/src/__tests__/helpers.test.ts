import { describe, it, expect } from "vitest";
import type { TaskStatus, ThreadStatus } from "@beanbag/core";
import { statusText as threadStatusText } from "../commands/thread.js";
import { statusText as taskStatusText } from "../commands/task.js";
import { formatTaskDescription } from "../task-format.js";

describe("thread statusText()", () => {
  const cases: Array<{ status: ThreadStatus; text: string }> = [
    { status: "created", text: "created" },
    { status: "provisioning", text: "provisioning" },
    { status: "provisioning_failed", text: "provisioning_failed" },
    { status: "idle", text: "idle" },
    { status: "active", text: "active" },
  ];

  for (const { status, text } of cases) {
    it(`returns ${text} for ${status}`, () => {
      expect(threadStatusText(status)).toBe(text);
    });
  }
});

describe("task statusText()", () => {
  const cases: Array<{ status: TaskStatus; text: string }> = [
    { status: "open", text: "open" },
    { status: "in_progress", text: "in_progress" },
    { status: "blocked", text: "blocked" },
    { status: "closed", text: "closed" },
  ];

  for (const { status, text } of cases) {
    it(`returns ${text} for ${status}`, () => {
      expect(taskStatusText(status)).toBe(text);
    });
  }
});

describe("formatTaskDescription()", () => {
  it("returns trimmed description when present", () => {
    expect(formatTaskDescription("  fix login flow  ")).toBe("fix login flow");
  });

  it("returns (none) for undefined or blank descriptions", () => {
    expect(formatTaskDescription(undefined)).toBe("(none)");
    expect(formatTaskDescription("   ")).toBe("(none)");
  });
});
