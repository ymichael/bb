import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { supervise } from "./process.js";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntime } from "./runtime.js";
import { z } from "zod";

const binary = z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_BINARY);
const chrome = z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_CHROME);
const root = await mkdtemp(join(tmpdir(), "bb-dev-browser-smoke-"));
const dataDir = join(root, "data");
await mkdir(join(dataDir, "runtime"), { recursive: true });
const runtimeBinary = join(dataDir, "runtime", "dev-browser");
await copyFile(resolve(binary), runtimeBinary);
const version = z
  .string()
  .regex(/^dev-browser \S+$/)
  .parse(
    (await promisify(execFile)(runtimeBinary, ["--version"])).stdout.trim(),
  )
  .split(" ")[1]!;
if (process.env.DEV_BROWSER_SMOKE_NO_SANDBOX === "1") {
  const escaped = `'${resolve(chrome).replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(dataDir, "runtime", "chrome"),
    `#!/bin/sh\nexec ${escaped} --no-sandbox "$@"\n`,
    { mode: 0o700 },
  );
} else await symlink(resolve(chrome), join(dataDir, "runtime", "chrome"));
const attachedBrowsers: ReturnType<typeof supervise>[] = [];
const sessions: Awaited<ReturnType<typeof createRuntime>>[] = [];
try {
  const args = {
    runtime: {
      binary: runtimeBinary,
      version,
      source: "developer-artifact" as const,
    },
    dataDir,
    tempDir: join(root, "sessions"),
    signal: new AbortController().signal,
  };
  const a = await createRuntime(args);
  sessions.push(a);
  const b = await createRuntime(args);
  sessions.push(b);
  const url =
    "data:text/html," +
    encodeURIComponent(
      `<button id="b" onclick="this.textContent='clicked'">press</button>`,
    );
  const script = `const p = await browser.getPage("main"); await p.goto(${JSON.stringify(url)}); await p.click("#b"); await p.snapshot()`;
  const result = await a.run(script, 15_000, args.signal);
  assert.equal(result.exitCode, 0, result.text);
  assert.match(result.text, /clicked/);
  const screenshot = await a.run(
    'const p = await browser.getPage("main"); await p.shot({ type: "jpeg", maxEdge: 960, quality: 70 }); undefined',
    10_000,
    args.signal,
  );
  assert.equal(screenshot.images.length, 1);
  assert.deepEqual(
    (await readFile(screenshot.images[0]!.path)).subarray(0, 3),
    Buffer.from([0xff, 0xd8, 0xff]),
  );
  assert.ok(screenshot.images[0]!.width <= 960);
  const one = a.run(
    'const p = await browser.getPage("main"); await new Promise(r => setTimeout(r, 100)); await p.evaluate(() => { window.sequence = 1 }); "first"',
    10_000,
    args.signal,
  );
  const two = a.run(
    'const p = await browser.getPage("main"); await p.evaluate(() => window.sequence)',
    10_000,
    args.signal,
  );
  assert.equal((await one).exitCode, 0);
  assert.equal((await two).text.trim(), "1");
  const controller = new AbortController();
  const running = a.run(
    "await new Promise(() => {})",
    10_000,
    controller.signal,
  );
  const cancellation = assert.rejects(running);
  setTimeout(() => controller.abort(), 100);
  await cancellation;
  assert.equal(
    (
      await b.run(
        'const p = await browser.getPage("main"); await p.goto("data:text/html,still-alive"); p.url()',
        10_000,
        args.signal,
      )
    ).exitCode,
    0,
  );
  const timeout = b.run("while (true) {}", 1000, args.signal);
  await assert.rejects(timeout);
  const c = await createRuntime(args);
  sessions.push(c);
  assert.equal(
    (await c.run("await browser.listPages()", 10_000, args.signal)).exitCode,
    0,
  );
  await c.stop();
  await assert.rejects(c.run("1", 1000, args.signal));
  const profile = join(root, "handed-off-profile");
  const attachedBrowser = supervise(
    join(dataDir, "runtime", "chrome"),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "about:blank",
    ],
    process.env,
  );
  attachedBrowsers.push(attachedBrowser);
  let portFile = "";
  const deadline = AbortSignal.timeout(15_000);
  while (!portFile) {
    deadline.throwIfAborted();
    try {
      portFile = await readFile(join(profile, "DevToolsActivePort"), "utf8");
    } catch {
      await delay(25);
    }
  }
  const [port, path] = portFile.trim().split("\n");
  const connectionUrl = `ws://127.0.0.1:${port}${path}`;
  const attached = await createRuntime({ ...args, connectionUrl });
  sessions.push(attached);
  assert.equal(
    (
      await attached.run(
        'const p = await browser.getPage("main"); await p.goto("data:text/html,handoff-preserved"); p.url()',
        10_000,
        args.signal,
      )
    ).exitCode,
    0,
  );
  await attached.stop();
  assert.equal(attachedBrowser.alive(), true);
  const reattached = await createRuntime({ ...args, connectionUrl });
  sessions.push(reattached);
  assert.match(
    (await reattached.run("await browser.listPages()", 10_000, args.signal))
      .text,
    /handoff-preserved/,
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "headless navigation and click",
        "readable temporary JPEG",
        "serialized scripts",
        "cancellation isolation",
        "infinite-loop timeout",
        "reopen after timeout",
        "stop rejects further work",
        "attachment stop preserves browser and page state",
      ],
    }),
  );
} finally {
  await Promise.all(sessions.map((session) => session.close()));
  await Promise.all(attachedBrowsers.map((browser) => browser.close()));
  await rm(root, { recursive: true, force: true });
}
