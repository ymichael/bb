import { describe, expect, it } from "vitest";
import { hostSchema } from "../src/host.js";

describe("host contract", () => {
  it("does not expose the deleted host type", () => {
    expect("type" in hostSchema.shape).toBe(false);
  });
});
