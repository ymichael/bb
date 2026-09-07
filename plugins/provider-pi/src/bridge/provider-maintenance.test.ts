import { describe, expect, it } from "vitest";
import { describePiVersionProbeFailure } from "./provider-maintenance.js";

describe("describePiVersionProbeFailure", () => {
  it("names execFile's own timeout with the 15 s budget", () => {
    expect(
      describePiVersionProbeFailure(
        Object.assign(new Error("spawn timeout"), {
          killed: true,
          signal: "SIGTERM",
          code: null,
        }),
      ),
    ).toBe("timed out after 15 s");
  });

  it("distinguishes an external SIGTERM from the timeout", () => {
    expect(
      describePiVersionProbeFailure(
        Object.assign(new Error("killed"), {
          killed: false,
          signal: "SIGTERM",
          code: null,
        }),
      ),
    ).toBe("was stopped by SIGTERM before it answered");
  });

  it("reports a non-zero exit and falls back to the message", () => {
    expect(
      describePiVersionProbeFailure(
        Object.assign(new Error("Command failed"), { code: 2, killed: false }),
      ),
    ).toBe("exited with 2");
    expect(describePiVersionProbeFailure(new Error("ENOENT: pi"))).toBe(
      "ENOENT: pi",
    );
  });
});
