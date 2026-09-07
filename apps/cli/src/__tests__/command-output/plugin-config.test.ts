import { describe, expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

function settingsResponse(value: number): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      schema: {
        retries: { type: "number", label: "Retries", default: 3 },
      },
      values: { retries: value },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("bb plugin config", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerPluginCommands(program, () => "http://server");

  it("accepts a negative number while preserving unknown-option errors", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(settingsResponse(3))
      .mockResolvedValueOnce(settingsResponse(-4.5));

    await runCommand(
      ["plugin", "config", "demo", "set", "retries", "-4.5"],
      register,
    );

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://server/api/v1/plugins/demo/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ values: { retries: -4.5 } }),
      }),
    );

    vi.mocked(fetch).mockClear();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await expect(
      runCommand(
        ["plugin", "config", "demo", "set", "retries", "3", "--bogus"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(stderr).toHaveBeenCalledWith("error: unknown option '--bogus'\n");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a negative value passed to unset", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCommand(
        ["plugin", "config", "demo", "unset", "retries", "-1"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(stderr).toHaveBeenCalledWith("error: unknown option '-1'\n");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a non-finite number before sending an update", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(settingsResponse(3));

    await expect(
      runCommand(
        ["plugin", "config", "demo", "set", "retries", "Infinity"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      'Setting "retries" is a number — pass a finite number.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
