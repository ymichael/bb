import { describe, it, expect } from "vitest";
import { formatUptime } from "../commands/daemon.js";
import { statusIcon } from "../commands/thread.js";

describe("formatUptime()", () => {
  it("formats seconds only", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(1)).toBe("1s");
    expect(formatUptime(30)).toBe("30s");
    expect(formatUptime(59)).toBe("59s");
    expect(formatUptime(59.9)).toBe("59s"); // floors, doesn't round
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(60)).toBe("1m 0s");
    expect(formatUptime(61)).toBe("1m 1s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(125)).toBe("2m 5s");
    expect(formatUptime(3599)).toBe("59m 59s");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(7200)).toBe("2h 0m");
    expect(formatUptime(7320)).toBe("2h 2m");
    expect(formatUptime(86400)).toBe("24h 0m");
  });

  it("drops seconds from hours display", () => {
    // 1h 1m 30s should display as 1h 1m (no seconds)
    expect(formatUptime(3690)).toBe("1h 1m");
  });
});

describe("statusIcon()", () => {
  it("returns dotted circle for created", () => {
    expect(statusIcon("created")).toBe("\u25CC");
  });

  it("returns half circle for provisioning", () => {
    expect(statusIcon("provisioning")).toBe("\u25D1");
  });

  it("returns fisheye circle for provisioning_failed", () => {
    expect(statusIcon("provisioning_failed")).toBe("\u25C9");
  });

  it("returns empty circle for idle", () => {
    expect(statusIcon("idle")).toBe("\u25CB");
  });

  it("returns quarter circle for active", () => {
    expect(statusIcon("active")).toBe("\u25D4");
  });

  it("returns ? for unknown status", () => {
    expect(statusIcon("unknown")).toBe("?");
    expect(statusIcon("")).toBe("?");
    expect(statusIcon("cancelled")).toBe("?");
  });
});
