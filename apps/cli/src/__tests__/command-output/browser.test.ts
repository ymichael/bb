import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerBrowserCommands } from "../../commands/browser.js";

const flags = [
  "--host",
  "host",
  "--instance",
  "instance",
  "--generation",
  "generation",
  "--thread",
  "thread",
];
describe("browser credential output", () => {
  setupCommandOutputTestEnvironment();
  it("writes a new private file without printing the connection credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-browser-cli-"));
    const output = join(dir, "connection.json");
    const connection = {
      hostId: "host",
      wsEndpoint: "ws://127.0.0.1:1234/private-token",
      expiresAt: Date.now() + 10000,
    };
    stubServerApi({
      "v1.desktop-browsers.connection.$post": vi.fn(async () => connection),
    });
    try {
      await runCommand(
        [
          "browser",
          "connection",
          "lease",
          ...flags,
          "--output",
          output,
          "--json",
        ],
        (program) => registerBrowserCommands(program, () => "http://server"),
      );
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(connection);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(
        JSON.stringify(collectLogPayloads(vi.mocked(console.log))),
      ).not.toContain("private-token");
      await expect(
        runCommand(
          ["browser", "connection", "lease", ...flags, "--output", output],
          (program) => registerBrowserCommands(program, () => "http://server"),
        ),
      ).rejects.toThrow();
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(connection);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
