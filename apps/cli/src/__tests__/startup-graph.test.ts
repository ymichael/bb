import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CORE_COMMAND_GROUPS } from "../command-groups.js";
import { readBbAppVersion } from "./bb-app-version.js";

const execFileAsync = promisify(execFile);
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceRoot = resolve(cliRoot, "..", "..");

const RESOLVE_HOOKS_SOURCE = `
import { appendFileSync } from "node:fs";
let logPath;
export function initialize(data) {
  logPath = data.logPath;
}
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  appendFileSync(logPath, result.url + "\\n");
  return result;
}
`;

const REGISTER_HOOKS_SOURCE = `
import { register } from "node:module";
register(new URL("./resolve-hooks.mjs", import.meta.url), {
  data: { logPath: process.env.BB_STARTUP_GRAPH_LOG },
});
`;

const STRIPPED_ENV_KEYS = new Set(["BB_CLI", "BB_APP_VERSION"]);

const cliPackageJsonSchema = z.object({
  scripts: z.object({ build: z.string() }),
});

type CliEntry = "source" | "dist";

interface CliRun {
  stdout: string;
  urls: string[];
}

describe("bb startup module graph", () => {
  let tempDir: string;
  let registerHooksPath: string;
  let distEntry: string;

  beforeAll(async () => {
    const packageTmpDir = join(cliRoot, ".tmp");
    await mkdir(packageTmpDir, { recursive: true });
    tempDir = await mkdtemp(join(packageTmpDir, "startup-graph-"));
    registerHooksPath = join(tempDir, "register-hooks.mjs");
    distEntry = join(tempDir, "dist", "index.js");
    await writeFile(join(tempDir, "resolve-hooks.mjs"), RESOLVE_HOOKS_SOURCE);
    await writeFile(registerHooksPath, REGISTER_HOOKS_SOURCE);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runCli(
    entry: CliEntry,
    args: string[],
    serverUrl?: string,
  ): Promise<CliRun> {
    const logPath = join(
      tempDir,
      `${entry}_${args.join("_").replace(/\W/g, "_")}.log`,
    );
    await writeFile(logPath, "");
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !STRIPPED_ENV_KEYS.has(key),
      ),
    );
    env.BB_CLI_REEXEC = "1";
    env.BB_STARTUP_GRAPH_LOG = logPath;
    if (serverUrl !== undefined) env.BB_SERVER_URL = serverUrl;
    const entryArgs =
      entry === "source"
        ? [
            "--conditions=source",
            "--import",
            "tsx",
            "--import",
            registerHooksPath,
            "src/index.ts",
          ]
        : ["--import", registerHooksPath, distEntry];
    const { stdout } = await execFileAsync(
      process.execPath,
      [...entryArgs, ...args],
      { cwd: cliRoot, env },
    );
    const urls = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    return { stdout, urls };
  }

  function loaded(run: CliRun, fragment: string): string[] {
    return run.urls.filter((url) => url.includes(fragment));
  }

  it("answers --version from commander and node builtins alone", async () => {
    const run = await runCli("source", ["--version"]);

    expect(run.stdout.trim()).toBe(await readBbAppVersion());

    expect(loaded(run, "/apps/cli/src/index.ts")).toHaveLength(1);
    expect(loaded(run, "/commander/")).not.toHaveLength(0);

    for (const fragment of [
      "/zod/",
      "/undici/",
      "/mime-types/",
      "/node_modules/ws/",
      "/packages/config/",
      "/packages/domain/",
      "/packages/sdk/",
      "/packages/server-contract/",
      "/packages/templates/",
      "/apps/cli/src/commands/",
      "/apps/cli/src/plugin-cli-proxy",
      "/apps/cli/src/context-env",
      "/apps/cli/src/client",
    ]) {
      expect(loaded(run, fragment), fragment).toEqual([]);
    }
  }, 30_000);

  it("loads only the named command group for `bb thread`", async () => {
    const run = await runCli("source", ["thread", "--help"]);

    expect(run.stdout).toContain("Usage: bb thread");
    expect(loaded(run, "/apps/cli/src/commands/thread/index.ts")).toHaveLength(
      1,
    );

    for (const fragment of [
      "/apps/cli/src/commands/plugin.ts",
      "/apps/cli/src/commands/project.ts",
      "/packages/plugin-build/",
      "/packages/templates/src/plugin-scaffold",
      "/mime-types/",
    ]) {
      expect(loaded(run, fragment), fragment).toEqual([]);
    }
  }, 30_000);

  it("shows and enforces the thread search result limit", async () => {
    const help = await runCli(
      "source",
      ["thread", "search", "--help"],
      "http://127.0.0.1:1",
    );
    expect(help.stdout).toContain("Maximum results per group (1-50)");

    await expect(
      runCli(
        "source",
        ["thread", "search", "query", "--limit", "51"],
        "http://127.0.0.1:1",
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Error: --limit must be at most 50."),
    });
  }, 30_000);

  describe("split dist/index.js", () => {
    let chunkDirUrl: string;

    beforeAll(async () => {
      chunkDirUrl = `${pathToFileURL(join(tempDir, "dist", "index-chunks")).href}/`;
      await execFileAsync(
        process.execPath,
        [
          resolve(workspaceRoot, "scripts", "build-node-entry.mjs"),
          "src/index.ts",
          distEntry,
          "--split",
        ],
        { cwd: cliRoot },
      );
    }, 60_000);

    it("is how @bb/cli#build builds the shipped CLI", async () => {
      const packageJson = cliPackageJsonSchema.parse(
        JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8")),
      );
      expect(packageJson.scripts.build.split(" ")).toContain("--split");
    });

    it("answers --version from the entry and its shared chunks alone", async () => {
      const run = await runCli("dist", ["--version"]);

      expect(run.stdout.trim()).toBe(await readBbAppVersion());
      expect(loaded(run, pathToFileURL(distEntry).href)).toHaveLength(1);

      const chunks = loaded(run, chunkDirUrl);
      expect(chunks).not.toHaveLength(0);
      for (const url of chunks) {
        expect(url).toMatch(/\/index-chunks\/chunk-[A-Z0-9]+\.js$/);
      }
    }, 30_000);

    it("loads only the thread chunk for `bb thread`", async () => {
      const run = await runCli("dist", ["thread", "--help"]);

      expect(run.stdout).toContain("Usage: bb thread");
      expect(loaded(run, `${chunkDirUrl}thread-`)).toHaveLength(1);

      const otherGroups = CORE_COMMAND_GROUPS.map((group) => group.name).filter(
        (name) => name !== "thread",
      );
      for (const name of [...otherGroups, "plugin-cli-proxy", "mime-types"]) {
        expect(loaded(run, `${chunkDirUrl}${name}-`), name).toEqual([]);
      }
    }, 30_000);

    it("uses registered plugin help from the split artifact", async () => {
      let pluginCalls = 0;
      const server = createServer(async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/v1/plugins/contributions") {
          response.end(
            JSON.stringify({
              cliCommands: [
                {
                  pluginId: "fixture-plugin",
                  name: "fixture",
                  summary: "Fixture command",
                  commands: [
                    {
                      name: "inspect",
                      summary: "Inspect a fixture",
                      usage: "bb fixture inspect <id>",
                    },
                  ],
                },
              ],
            }),
          );
          return;
        }
        if (request.url !== "/api/v1/plugins/fixture-plugin/cli") {
          response.statusCode = 404;
          response.end();
          return;
        }
        pluginCalls += 1;
        let body = "";
        for await (const chunk of request) body += chunk;
        const { argv } = z
          .object({ argv: z.array(z.string()) })
          .parse(JSON.parse(body));
        response.end(
          JSON.stringify({
            exitCode: 0,
            stdout: `fixture ran: ${argv.join(" ")}`,
            stderr: "",
          }),
        );
      });
      await new Promise<void>((resolvePromise) =>
        server.listen(0, "127.0.0.1", resolvePromise),
      );
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Fixture server did not bind to a TCP port");
      }
      const serverUrl = `http://127.0.0.1:${address.port}`;

      try {
        for (const helpFlag of ["-h", "--help"]) {
          const run = await runCli(
            "dist",
            ["fixture", "inspect", helpFlag],
            serverUrl,
          );
          expect(run.stdout).toBe("bb fixture inspect <id>\n");
        }
        expect(pluginCalls).toBe(0);

        const direct = await runCli(
          "dist",
          ["fixture", "inspect", "fixture-1"],
          serverUrl,
        );
        expect(direct.stdout).toBe("fixture ran: inspect fixture-1\n");

        const raw = await runCli(
          "dist",
          ["plugin", "run", "fixture-plugin", "--help"],
          serverUrl,
        );
        expect(raw.stdout).toBe("fixture ran: --help\n");
        expect(pluginCalls).toBe(2);
      } finally {
        await new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) =>
            error ? rejectPromise(error) : resolvePromise(),
          ),
        );
      }
    }, 30_000);
  });
});
