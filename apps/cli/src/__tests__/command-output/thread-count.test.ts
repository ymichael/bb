import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread count command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  // The ungrouped count is one number, so it prints as one number and stays
  // pipeable without --json.
  it("bb thread count prints the bare total and sends only the filters given", async () => {
    const get = vi.fn(async () => ({ total: 3 }));
    stubServerApi({ "v1.threads.count.$get": get });

    await runCommand(
      ["thread", "count", "--status", "active", "--host", "host_a"],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      query: { status: "active", hostId: "host_a" },
    });
    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("3");
  });

  // "none" is the root-parent sentinel, not a thread id: it must reach the
  // route verbatim so the count excludes every child thread.
  it("bb thread count --parent none passes the root sentinel through", async () => {
    const get = vi.fn(async () => ({ total: 0 }));
    stubServerApi({ "v1.threads.count.$get": get });

    await runCommand(["thread", "count", "--parent", "none"], register);

    expect(get).toHaveBeenCalledWith({ query: { parentThreadId: "none" } });
    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("0");
  });

  it("bb thread count --by renders one row per group, largest first, with a total", async () => {
    const get = vi.fn(async () => ({
      total: 6,
      groups: [
        { key: null, count: 1 },
        { key: "host_a", count: 2 },
        { key: "host_b", count: 3 },
      ],
    }));
    stubServerApi({ "v1.threads.count.$get": get });

    await runCommand(["thread", "count", "--by", "host"], register);

    expect(get).toHaveBeenCalledWith({ query: { groupBy: "host" } });
    const lines = collectLogLines(vi.mocked(console.log))
      .join("\n")
      .split("\n")
      // Drop blank spacers and the table's head rule.
      .filter((line) => /[a-zA-Z0-9]/.test(line));
    expect(lines[0]).toContain("Machine");
    expect(lines[0]).toContain("Count");
    expect(lines[1]).toContain("host_b");
    expect(lines[2]).toContain("host_a");
    // A thread with no host still counts, under a "-" key sorted last.
    expect(lines[3].trim().startsWith("-")).toBe(true);
    expect(lines.at(-1)).toBe("Total: 6");
  });

  it("bb thread count --by reports an empty grouped result instead of an empty table", async () => {
    const get = vi.fn(async () => ({ total: 0, groups: [] }));
    stubServerApi({ "v1.threads.count.$get": get });

    await runCommand(["thread", "count", "--by", "project"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("No threads found");
  });

  it("bb thread count rejects an unknown --by dimension before requesting", async () => {
    const get = vi.fn(async () => ({ total: 0 }));
    stubServerApi({ "v1.threads.count.$get": get });

    await expect(
      runCommand(["thread", "count", "--by", "machine"], register),
    ).rejects.toThrow("process.exit:1");

    expect(get).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      "Invalid --by value 'machine'",
    );
  });

  it("bb thread count rejects an unknown --status before requesting", async () => {
    const get = vi.fn(async () => ({ total: 0 }));
    stubServerApi({ "v1.threads.count.$get": get });

    await expect(
      runCommand(["thread", "count", "--status", "busy"], register),
    ).rejects.toThrow("process.exit:1");

    expect(get).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      "Invalid --status value 'busy'",
    );
  });

  it("bb thread count --json prints the raw grouped response", async () => {
    const get = vi.fn(async () => ({
      total: 2,
      groups: [{ key: "codex", count: 2 }],
    }));
    stubServerApi({ "v1.threads.count.$get": get });

    await runCommand(
      ["thread", "count", "--by", "provider", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({ total: 2, groups: [{ key: "codex", count: 2 }] });
  });
});
