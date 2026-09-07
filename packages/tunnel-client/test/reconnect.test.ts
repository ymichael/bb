import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  ReconnectBackoff,
} from "../src/reconnect.js";
import { humanizeTransportError } from "../src/humanize.js";

describe("ReconnectBackoff", () => {
  it("grows exponentially and caps at max", () => {
    const backoff = new ReconnectBackoff();
    expect(backoff.nextDelayAfterClose(0)).toBe(
      DEFAULT_RECONNECT_BASE_DELAY_MS * 2,
    );
    expect(backoff.nextDelayAfterClose(0)).toBe(
      DEFAULT_RECONNECT_BASE_DELAY_MS * 4,
    );
    expect(backoff.nextDelayAfterClose(0)).toBe(
      DEFAULT_RECONNECT_BASE_DELAY_MS * 8,
    );
    let delay = 0;
    for (let i = 0; i < 20; i++) {
      delay = backoff.nextDelayAfterClose(0);
    }
    expect(delay).toBe(DEFAULT_MAX_RECONNECT_DELAY_MS);
  });

  it("resets attempt after a stable connection", () => {
    const backoff = new ReconnectBackoff({ stableConnectionMs: 10_000 });
    expect(backoff.nextDelayAfterClose(0)).toBe(2_000);
    expect(backoff.nextDelayAfterClose(10_001)).toBe(1_000);
  });

  it("does not reset at exactly the stable threshold", () => {
    const backoff = new ReconnectBackoff({ stableConnectionMs: 10_000 });
    expect(backoff.nextDelayAfterClose(0)).toBe(2_000);
    expect(backoff.nextDelayAfterClose(10_000)).toBe(4_000);
  });

  it("reset() clears the attempt counter", () => {
    const backoff = new ReconnectBackoff();
    backoff.nextDelayAfterClose(0);
    backoff.nextDelayAfterClose(0);
    backoff.reset();
    expect(backoff.nextDelayAfterClose(0)).toBe(2_000);
  });
});

describe("humanizeTransportError", () => {
  it("maps known errno codes to short reasons", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(humanizeTransportError(refused, "getbb.app")).toBe(
      "can't reach getbb.app — connection refused",
    );
  });

  it("falls back to the raw message for unknown failures", () => {
    expect(humanizeTransportError(new Error("boom"), "host.example")).toBe(
      "can't reach host.example — boom",
    );
  });
});
