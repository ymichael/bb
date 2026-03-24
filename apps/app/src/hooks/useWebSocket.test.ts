import { describe, expect, it } from "vitest";
import { shouldFlushThreadChangesImmediately } from "./useWebSocket";

describe("shouldFlushThreadChangesImmediately", () => {
  it("flushes status changes immediately", () => {
    expect(
      shouldFlushThreadChangesImmediately([
        "events-appended",
        "status-changed",
      ]),
    ).toBe(true);
  });

  it("does not fast-flush pure timeline appends", () => {
    expect(shouldFlushThreadChangesImmediately(["events-appended"])).toBe(false);
  });
});
