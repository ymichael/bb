import { describe, expect, it } from "vitest";
import { resolveStoredStandardManagerTimelinePreference } from "./manager-timeline-view-preference";

describe("resolveStoredStandardManagerTimelinePreference", () => {
  it("uses the current preference when present", () => {
    expect(
      resolveStoredStandardManagerTimelinePreference({
        currentValue: "false",
        legacyValue: "true",
        initialValue: true,
      }),
    ).toBe(false);
  });

  it("does not read the legacy preference when the current key is present", () => {
    expect(
      resolveStoredStandardManagerTimelinePreference({
        currentValue: "invalid",
        legacyValue: "true",
        initialValue: false,
      }),
    ).toBe(false);
  });

  it("falls back to the legacy show-all-events preference", () => {
    expect(
      resolveStoredStandardManagerTimelinePreference({
        currentValue: null,
        legacyValue: "true",
        initialValue: false,
      }),
    ).toBe(true);
  });

  it("keeps the initial value when stored values are invalid", () => {
    expect(
      resolveStoredStandardManagerTimelinePreference({
        currentValue: null,
        legacyValue: "show-all",
        initialValue: false,
      }),
    ).toBe(false);
  });
});
