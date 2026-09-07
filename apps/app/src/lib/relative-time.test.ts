import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time";

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("collapses sub-minute and future gaps to 'just now'", () => {
    expect(formatRelativeTime({ timestamp: NOW, now: NOW })).toBe("just now");
    expect(formatRelativeTime({ timestamp: NOW - 30 * 1000, now: NOW })).toBe(
      "just now",
    );
    expect(formatRelativeTime({ timestamp: NOW + 5 * 1000, now: NOW })).toBe(
      "just now",
    );
  });

  it("renders minutes and hours", () => {
    expect(formatRelativeTime({ timestamp: NOW - 2 * MINUTE, now: NOW })).toBe(
      "2m ago",
    );
    expect(formatRelativeTime({ timestamp: NOW - 59 * MINUTE, now: NOW })).toBe(
      "59m ago",
    );
    expect(formatRelativeTime({ timestamp: NOW - 3 * HOUR, now: NOW })).toBe(
      "3h ago",
    );
  });

  it("renders Yesterday, days, and weeks", () => {
    expect(formatRelativeTime({ timestamp: NOW - 25 * HOUR, now: NOW })).toBe(
      "Yesterday",
    );
    expect(formatRelativeTime({ timestamp: NOW - 2 * DAY, now: NOW })).toBe(
      "2d ago",
    );
    expect(formatRelativeTime({ timestamp: NOW - 6 * DAY, now: NOW })).toBe(
      "6d ago",
    );
    expect(formatRelativeTime({ timestamp: NOW - 14 * DAY, now: NOW })).toBe(
      "2w ago",
    );
  });

  it("falls back to a short absolute date beyond a few weeks", () => {
    const timestamp = NOW - 60 * DAY;
    expect(formatRelativeTime({ timestamp, now: NOW })).toBe(
      new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
  });
});
