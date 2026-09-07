import { describe, expect, it } from "vitest";
import { parseCli } from "./cli.js";
import { rpcContract } from "./contracts.js";

const id = "1a12a3f1-12de-4fbb-a011-df0905678757";
describe("CLI boundaries", () => {
  it("requires explicit backend, host, and headless selection", () => {
    expect(() =>
      parseCli(["open", "--backend", "local", "--machine", "host"], "thread"),
    ).toThrow("--headless");
    expect(
      parseCli(
        ["open", "--backend", "local", "--machine", "host", "--headless"],
        "thread",
      ).input.selection,
    ).toEqual({ backend: "local", hostId: "host" });
    expect(() => parseCli(["open", "--backend", "cloud"], "thread")).toThrow();
  });
  it("rejects cross-thread and ignored flags", () => {
    expect(() => parseCli(["list", "--thread", "other"], "thread")).toThrow(
      "another thread",
    );
    expect(() => parseCli(["list", "--headless"], "thread")).toThrow("Unknown");
    expect(() =>
      parseCli(["run", id, "--script", "1", "--script-file", "a.js"], "thread"),
    ).toThrow("exactly one");
    expect(() => parseCli(["list", "--json", "--json"], "thread")).toThrow(
      "duplicate",
    );
  });
  it("preserves script strings and validates timeout at the common boundary", () => {
    const parsed = parseCli(
      [
        "run",
        id,
        "--script",
        "await browser.getPage('main')",
        "--timeout-ms",
        "1",
      ],
      "thread",
    );
    expect(parsed.input.script).toBe("await browser.getPage('main')");
    expect(() => rpcContract.run.input.parse(parsed.input)).toThrow();
  });
});
