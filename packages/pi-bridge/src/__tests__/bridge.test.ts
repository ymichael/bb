import { describe, expect, it } from "vitest";
import { BRIDGE_METHODS } from "../bridge.js";

describe("bridge", () => {
  it("exports expected RPC methods", () => {
    expect(BRIDGE_METHODS).toContain("initialize");
    expect(BRIDGE_METHODS).toContain("thread/start");
    expect(BRIDGE_METHODS).toContain("thread/resume");
    expect(BRIDGE_METHODS).toContain("turn/start");
    expect(BRIDGE_METHODS).toContain("turn/steer");
    expect(BRIDGE_METHODS).toContain("thread/stop");
  });
});
