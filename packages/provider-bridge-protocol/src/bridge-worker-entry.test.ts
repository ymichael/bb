import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const workerEntry = fileURLToPath(
  new URL("./bridge-worker-entry.ts", import.meta.url),
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(bridgeSource: string): Promise<{
  bridgeModulePath: string;
  dataDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "bb-bridge-bootstrap-"));
  tempDirs.push(dir);
  const bridgeModulePath = join(dir, "artifact.mjs");
  await writeFile(bridgeModulePath, bridgeSource);
  return { bridgeModulePath, dataDir: dir };
}

function runWorker(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          import.meta.resolve("tsx"),
          workerEntry,
          ...args,
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.end(stdin);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

it("starts an exported bridge with its plugin-scoped directories", async () => {
  const fixture = await createFixture(
    [
      "let context = null;",
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  start(value) { context = value; },",
      "  handleLine(line) {",
      "    process.stdout.write(JSON.stringify({ line, context }) + '\\n');",
      "  },",
      "};",
    ].join("\n"),
  );

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    '{"hello":true}\n',
  );

  expect(result.code).toBe(0);
  const reported = JSON.parse(result.stdout.trim()) as {
    line: string;
    context: { pluginId: string; dataDir: string; tempDir: string };
  };
  expect(reported.line).toBe('{"hello":true}');
  expect(reported.context.pluginId).toBe("provider-fixture");
  expect(reported.context.dataDir).toBe(fixture.dataDir);
  expect(reported.context.tempDir).toContain("provider-fixture");
  expect(existsSync(reported.context.tempDir)).toBe(false);
});

it("refuses an artifact with no bridge export, naming the plugin", async () => {
  const fixture = await createFixture("export default { notABridge: true };\n");

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "",
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('plugin "provider-fixture"');
  expect(result.stderr).toContain("experimental_providerBridge");
});

it("refuses a bridge export from an unsupported api version", async () => {
  const fixture = await createFixture(
    "export const experimental_providerBridge = { experimental_apiVersion: 99, handleLine() {} };\n",
  );

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "",
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unsupported apiVersion 99");
});

it("reports a bridge module that fails to load", async () => {
  const fixture = await createFixture("throw new Error('boom at import');\n");

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "",
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    'plugin "provider-fixture" failed to load its provider bridge',
  );
  expect(result.stderr).toContain("boom at import");
});

it("hands a bridge only what it declares: no start hook, no context", async () => {
  const fixture = await createFixture(
    [
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  handleLine(line) { process.stdout.write(line + '\\n'); },",
      "  onClose() { process.stdout.write('closed\\n'); },",
      "};",
    ].join("\n"),
  );

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "one\ntwo\n",
  );

  expect(result.stdout).toBe("one\ntwo\nclosed\n");
  expect(await readFile(fixture.bridgeModulePath, "utf8")).toContain(
    "experimental_providerBridge",
  );
});

it("tees both sides of the runtime wire when record mode is on", async () => {
  const fixture = await createFixture(
    [
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  handleLine(line) {",
      "    const request = JSON.parse(line);",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');",
      "  },",
      "};",
    ].join("\n"),
  );
  const recordDir = join(fixture.dataDir, "recordings");

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"threadId":"thr_rec"}}\n',
    { BB_PROVIDER_BRIDGE_RECORD_DIR: recordDir },
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n',
  );
  const read = async (scope: string, direction: string) =>
    (await readFile(join(recordDir, scope, `${direction}.ndjson`), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { seq: number; dir: string; line: string },
      );
  expect((await read("_process", "runtime→bridge")).map((e) => e.line)).toEqual(
    ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'],
  );
  expect((await read("_process", "bridge→runtime")).map((e) => e.line)).toEqual(
    ['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'],
  );
  expect((await read("thr_rec", "runtime→bridge")).map((e) => e.line)).toEqual([
    '{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"threadId":"thr_rec"}}',
  ]);
  expect((await read("thr_rec", "bridge→runtime")).map((e) => e.dir)).toEqual([
    "bridge→runtime",
  ]);
});
