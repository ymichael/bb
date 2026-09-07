import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { outputSchema, type RunOutput } from "./contracts.js";
import { execute, supervise } from "./process.js";
import type { ResolvedRuntime } from "./runtime-pin.js";

const frameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(1),
    version: z.string(),
    pid: z.number().int().positive(),
  }),
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("result"), value: z.string() }),
  z.object({
    type: z.literal("error"),
    kind: z.string(),
    name: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    path: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("done"),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
  }),
]);

export function runtimeEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.DEV_BROWSER_HOME = home;
  env.DEV_BROWSER_SOCKET = join(home, "daemon.sock");
  return env;
}

export async function decodeOutput(
  stdout: string,
  home: string,
  connectionUrl: string,
  version: string,
): Promise<RunOutput> {
  const text: string[] = [];
  const images: RunOutput["images"] = [];
  let imageBytes = 0;
  let exitCode: number | null = null;
  for (const line of stdout.split("\n").filter(Boolean)) {
    if (exitCode !== null)
      throw new Error("DevBrowser emitted data after completion");
    const frame = frameSchema.parse(JSON.parse(line));
    if (frame.type === "done") exitCode = frame.exitCode;
    else if (frame.type === "hello") {
      if (frame.version !== version)
        throw new Error(
          `DevBrowser daemon reports version ${frame.version}, expected ${version}`,
        );
    } else if (frame.type === "stdout" || frame.type === "stderr")
      text.push(frame.data);
    else if (frame.type === "result") text.push(frame.value);
    else if (frame.type === "error")
      text.push(`${frame.name}: ${frame.message}`);
    else if (frame.type === "image") {
      if (images.length >= 4)
        throw new Error("At most four screenshots may be returned per script");
      const root = await realpath(join(home, "tmp"));
      const path = await realpath(frame.path);
      const rel = relative(root, path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Screenshot escaped the session capture directory");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 500_000)
          throw new Error("Screenshot must be a JPEG smaller than 500 KB");
        const bytes = await file.readFile();
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
          throw new Error("Only JPEG screenshots are supported");
        imageBytes += bytes.length;
        if (imageBytes > 500_000)
          throw new Error(
            "Combined screenshots exceed the 500 KB output budget",
          );
        images.push({
          path,
          mimeType: "image/jpeg",
          width: frame.width,
          height: frame.height,
        });
      } finally {
        await file.close();
      }
    }
  }
  if (exitCode === null)
    throw new Error("DevBrowser did not return a completion frame");
  const endpoint = new URL(connectionUrl);
  let safeText = text
    .join("\n")
    .split(connectionUrl)
    .join("[browser connection]")
    .split(home)
    .join("[session storage]");
  const pathCredential = endpoint.pathname.match(
    /^\/devtools\/browser\/([^/]+)$/,
  )?.[1];
  if (pathCredential) {
    safeText = safeText
      .split(endpoint.pathname)
      .join("[browser connection]")
      .split(pathCredential)
      .join("[credential]");
  }
  for (const value of endpoint.searchParams.values())
    if (value) safeText = safeText.split(value).join("[credential]");
  return outputSchema.parse({
    text: safeText.slice(0, 160_000),
    images,
    exitCode,
  });
}

async function findChrome(dataDir: string): Promise<string> {
  const candidates = [
    join(dataDir, "runtime", "chrome"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ])
      candidates.push(join(dir, name));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error(
    "Install Chrome/Chromium on this host or link its executable at the plugin data runtime/chrome path.",
  );
}

export interface RuntimeSession {
  run(
    script: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RunOutput>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function createRuntime(args: {
  runtime: ResolvedRuntime;
  dataDir: string;
  tempDir: string;
  connectionUrl?: string;
  signal: AbortSignal;
}): Promise<RuntimeSession> {
  const binary = args.runtime.binary;
  await mkdir(args.tempDir, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(args.tempDir, "db-"));
  const env = runtimeEnvironment(home);
  const processes: ReturnType<typeof supervise>[] = [];
  let closed = false;
  let closing: Promise<void> | null = null;
  const stopped = new AbortController();
  let queue = Promise.resolve();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    stopped.abort();
    closing = (async () => {
      await Promise.all(processes.map((child) => child.close()));
      await rm(home, { recursive: true, force: true });
    })();
    return closing;
  };
  const startup = AbortSignal.any([args.signal, AbortSignal.timeout(30_000)]);
  async function waitForFile(path: string): Promise<string> {
    while (true) {
      startup.throwIfAborted();
      if (processes.some((child) => !child.alive()))
        throw new Error(
          "Browser runtime exited during startup; check Chrome installation and sandbox support.",
        );
      try {
        return await readFile(path, "utf8");
      } catch {
        await delay(25, undefined, { signal: startup });
      }
    }
  }
  try {
    let connectionUrl = args.connectionUrl;
    if (connectionUrl === undefined) {
      const chrome = await findChrome(args.dataDir);
      const profile = join(home, "profile");
      processes.push(
        supervise(
          chrome,
          [
            "--headless=new",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1280,720",
            "about:blank",
          ],
          env,
        ),
      );
      const lines = (await waitForFile(join(profile, "DevToolsActivePort")))
        .trim()
        .split("\n");
      const port = z.coerce.number().int().min(1).max(65535).parse(lines[0]);
      const path = z
        .string()
        .regex(/^\/devtools\/browser\/[a-zA-Z0-9-]+$/)
        .parse(lines[1]);
      connectionUrl = `ws://127.0.0.1:${port}${path}`;
    }
    const endpoint = new URL(connectionUrl);
    if (
      endpoint.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    )
      throw new Error(
        "Desktop connection must be a private loopback WebSocket on the selected host",
      );
    processes.push(supervise(binary, ["daemon"], env));
    await waitForFile(join(home, "daemon.pid"));
    const url = connectionUrl;
    const run = (
      script: string,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<RunOutput> => {
      const result = queue.then(async () => {
        const deadline = AbortSignal.any([
          signal,
          stopped.signal,
          AbortSignal.timeout(timeoutMs),
        ]);
        deadline.throwIfAborted();
        if (closed || processes.some((child) => !child.alive()))
          throw new Error("Browser session stopped; open a new session");
        try {
          const stdout = await execute(
            binary,
            [
              "--json",
              "--connect",
              url,
              "--timeout",
              String(Math.ceil(timeoutMs / 1000)),
              "--quiet-page",
              "-e",
              script,
            ],
            env,
            deadline,
          );
          const output = await decodeOutput(
            stdout,
            home,
            url,
            args.runtime.version,
          );
          if (output.exitCode === 124) await close();
          return output;
        } catch (error) {
          await close();
          throw error;
        }
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    await run("await browser.listPages()", 30_000, startup);
    return { run, stop: close, close };
  } catch (error) {
    await close();
    throw error;
  }
}
