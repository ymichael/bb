import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";
import { createNodeBbSdk } from "@bb/sdk";
import { getStoredThreadTabs } from "@bb/db";
import { desktopBrowserCommandSchema } from "@bb/host-daemon-contract";
import { threadTabsSchema } from "@bb/server-contract";
import { startDesktopBrowserBroker } from "../../host-daemon/src/desktop-browser-broker.ts";
import { onDaemonSocketMessage } from "../src/ws/daemon-protocol.ts";
import { registerHostRpcResponder } from "../test/helpers/host-rpc.ts";
import { seedThreadFixture } from "../test/helpers/seed.ts";
import { startTestServer } from "../test/helpers/test-app.ts";
const execute = promisify(execFile);
const config = z
  .object({
    artifacts: z.string(),
    devBrowser: z.string(),
    checksum: z.string(),
    source: z.enum(["release", "local"]),
    electron: z.string(),
    electronFixture: z.string(),
    repoRoot: z.string(),
  })
  .parse(
    JSON.parse(await readFile(z.string().parse(process.argv.at(-1)), "utf8")),
  );
const steps = [];
const credentials = new Set();
function redact(text) {
  for (const credential of credentials)
    text = text.replaceAll(credential, "<credential>");
  return text;
}
async function run(binary, args, env) {
  try {
    const result = await execute(binary, args, {
      cwd: config.artifacts,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const parsed = z
      .object({ message: z.string(), stderr: z.string().optional() })
      .safeParse(error);
    throw new Error(
      redact(
        parsed.success
          ? `${parsed.data.message}
${parsed.data.stderr ?? ""}`
          : "Child command failed",
      ),
    );
  }
}
async function until(probe, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`);
}
async function refused(endpoint) {
  const socket = new WebSocket(endpoint, { handshakeTimeout: 2_000 });
  const outcome = await new Promise((resolve) => {
    socket.once("open", () => resolve(false));
    socket.once("error", () => resolve(true));
    socket.once("close", () => resolve(true));
  });
  socket.terminate();
  assert(outcome, "Revoked endpoint accepted a new connection");
}
const server = await startTestServer({ seedFirstPartyProviders: false });
const seeded = seedThreadFixture(server);
const browserServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><title>Broker integration fixture</title><label>Name <input id="name"></label><button id="submit" onclick="document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value">Submit</button><p id="result">Waiting</p>`,
  );
});
await new Promise((resolve) => browserServer.listen(0, "127.0.0.1", resolve));
const pageAddress = browserServer.address();
assert(pageAddress && typeof pageAddress !== "string");
const pageUrl = `http://127.0.0.1:${pageAddress.port}/fixture`;
const broker = await startDesktopBrowserBroker({
  dataDir: process.env.BB_DATA_DIR ?? join(config.artifacts, "bb-data"),
  hostId: seeded.host.id,
  serverUrl: server.baseUrl,
  onChanged(event) {
    onDaemonSocketMessage(server.deps, {
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      raw: JSON.stringify(event),
      socket: {
        close: () => {
          throw new Error("Native snapshot was rejected");
        },
        send: () => {},
      },
    });
  },
});
credentials.add(broker.descriptor.token);
const responder = registerHostRpcResponder(server, {
  hostId: seeded.host.id,
  sessionId: seeded.session.id,
  async handle(request) {
    return {
      ok: true,
      result: await broker.request(
        desktopBrowserCommandSchema.parse(request.command),
      ),
    };
  },
});
broker.setConnected(true);
const electronConfig = join(config.artifacts, "electron-config.json");
await writeFile(
  electronConfig,
  JSON.stringify({
    artifacts: config.artifacts,
    dataDir: process.env.BB_DATA_DIR,
    serverUrl: server.baseUrl,
  }),
  { mode: 0o600 },
);
const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: process.env.LANG,
  BB_DATA_DIR: process.env.BB_DATA_DIR,
  BB_SERVER_URL: server.baseUrl,
  DEV_BROWSER_HOME: join(config.artifacts, "dev-browser-state"),
  NODE_ENV: "test",
};
const electron = spawn(
  "xvfb-run",
  [
    "-a",
    config.electron,
    "--no-sandbox",
    config.electronFixture,
    electronConfig,
  ],
  {
    cwd: config.artifacts,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
function killElectronGroup() {
  if (electron.pid === void 0) return;
  try {
    process.kill(-electron.pid, "SIGKILL");
  } catch {}
}
process.once("SIGTERM", () => {
  killElectronGroup();
  process.exit(1);
});
const electronOutput = [];
let outputBytes = 0;
const capture = (data) => {
  outputBytes += data.length;
  if (outputBytes < 1024 * 1024) electronOutput.push(data);
};
electron.stdout.on("data", capture);
electron.stderr.on("data", capture);
const electronExited = new Promise((resolve) =>
  electron.once("exit", () => resolve()),
);
electron.once("error", (error) => capture(Buffer.from(error.message)));
const sdk = createNodeBbSdk({ baseUrl: server.baseUrl, timeoutMs: 15e3 });
const api = sdk.experimental_desktopBrowsers;
let devStarted = false;
let devBrowserVersion = "";
let succeeded = false;
try {
  devBrowserVersion = await run(config.devBrowser, ["--version"], childEnv);
  const instance = await until(async () => {
    const { instances } = await api.listInstances({ hostId: seeded.host.id });
    return instances[0] ?? null;
  }, "Electron registered with authenticated daemon broker");
  steps.push("real Electron registration through private daemon descriptor");
  const scope = {
    hostId: seeded.host.id,
    instanceId: instance.instanceId,
    generation: instance.generation,
    threadId: seeded.thread.id,
  };
  const { tab } = await api.createTab({ ...scope, url: pageUrl });
  assert.equal(tab.profile.kind, "automation");
  assert.equal(tab.presentation, "hidden");
  const listed = await api.listTabs(scope);
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0]?.tabId, tab.tabId);
  const stored = getStoredThreadTabs(server.db, seeded.thread.id);
  assert(stored);
  assert.deepEqual(
    threadTabsSchema.parse(JSON.parse(stored.tabsJson))[0]?.kind,
    "browser",
  );
  steps.push("SDK create/list persisted native automation tab");
  const lease = await api.acquireControl({
    ...scope,
    tabIds: [tab.tabId],
    controllerLabel: "Broker smoke",
    ttlMs: 6e4,
  });
  const leaseRequest = { ...scope, leaseId: lease.leaseId };
  const connection = await api.openConnection(leaseRequest);
  credentials.add(connection.wsEndpoint);
  const cli = [join(config.repoRoot, "apps/cli/dist/index.js")];
  const flags = [
    "--host",
    scope.hostId,
    "--instance",
    scope.instanceId,
    "--generation",
    scope.generation,
    "--thread",
    scope.threadId,
    "--json",
  ];
  const cliTabs = z
    .object({ tabs: z.array(z.object({ tabId: z.string() })) })
    .parse(
      JSON.parse(
        await run(
          process.execPath,
          [...cli, "browser", "tabs", ...flags],
          childEnv,
        ),
      ),
    );
  assert.equal(cliTabs.tabs[0]?.tabId, tab.tabId);
  const credentialFile = join(config.artifacts, "cli-connection.json");
  const cliOutput = await run(
    process.execPath,
    [
      ...cli,
      "browser",
      "connection",
      lease.leaseId,
      ...flags,
      "--output",
      credentialFile,
    ],
    childEnv,
  );
  assert(!cliOutput.includes(connection.wsEndpoint));
  assert.equal((await stat(credentialFile)).mode & 511, 384);
  const cliConnection = z
    .object({ wsEndpoint: z.string() })
    .parse(JSON.parse(await readFile(credentialFile, "utf8")));
  assert.equal(cliConnection.wsEndpoint, connection.wsEndpoint);
  steps.push("actual bb CLI tabs and private connection file");
  const diagnosticScript = `
    const pages = await browser.listPages();
    const page = await browser.getPage(pages[0].id);
    await page.goto(${JSON.stringify(pageUrl)});
    await page.fill('#name','Broker');
    const snapshot = await page.snapshot({interactive:true});
    const metrics = await page.$eval('#submit', node => {
      const rect=node.getBoundingClientRect();
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,visibility:document.visibilityState,hidden:document.hidden,elementAtPoint:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.tagName};
    });
    JSON.stringify({snapshot,metrics});
  `;
  devStarted = true;
  const diagnostic = await run(
    config.devBrowser,
    ["--connect", connection.wsEndpoint, "-t", "10", "-e", diagnosticScript],
    childEnv,
  );
  await writeFile(join(config.artifacts, "before-click.txt"), diagnostic);
  const script = `
    const pages = await browser.listPages();
    if (pages.length !== 1) throw new Error('Unexpected tab scope');
    const page = await browser.getPage(pages[0].id);
    await page.goto(${JSON.stringify(pageUrl)});
    await page.fill('#name', 'Broker');
    const snapshot = await page.snapshot({interactive:true});
    const button = snapshot.split('\\n').find(line=>line.includes('Submit'));
    const ref = button && button.match(/ref=(e\\d+)/)?.[1];
    if (!ref) throw new Error('Missing Submit ref');
    const metrics = await page.$eval('#submit', node => {
      const rect = node.getBoundingClientRect();
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,visibility:document.visibilityState,hidden:document.hidden,elementAtPoint:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.tagName};
    });
    try { await page.click('ref/'+ref); } catch (error) { throw new Error(JSON.stringify(metrics)+' '+error.message); }
    if (await page.$eval('#result', node=>node.textContent) !== 'Hello Broker') throw new Error('Action did not reach native page');
    'BROKER_SMOKE_ACTION_OK';
  `;
  devStarted = true;
  assert.match(
    await run(
      config.devBrowser,
      ["--connect", connection.wsEndpoint, "-t", "20", "-e", script],
      childEnv,
    ),
    /BROKER_SMOKE_ACTION_OK/u,
  );
  const captured = await api.captureTab({ ...scope, tabId: tab.tabId });
  assert.equal(captured.mimeType, "image/jpeg");
  assert(captured.width > 0 && captured.height > 0);
  const image = Buffer.from(captured.base64, "base64");
  assert(image.length > 100);
  assert.equal(image.subarray(0, 2).toString("hex"), "ffd8");
  await writeFile(join(config.artifacts, "native-capture.jpg"), image);
  assert.equal(
    (await api.listTabs(scope)).tabs.find((value) => value.tabId === tab.tabId)
      ?.presentation,
    "hidden",
  );
  steps.push("DevBrowser ref click and native JPEG capture through SDK");
  await api.releaseControl(leaseRequest);
  await refused(connection.wsEndpoint);
  await assert.rejects(api.openConnection(leaseRequest));
  await run(config.devBrowser, ["stop"], childEnv);
  devStarted = false;
  steps.push("release denies scoped endpoint reconnect and SDK reopen");
  const secondLease = await api.acquireControl({
    ...scope,
    tabIds: [tab.tabId],
    controllerLabel: "Disconnect smoke",
    ttlMs: 6e4,
  });
  const secondConnection = await api.openConnection({
    ...scope,
    leaseId: secondLease.leaseId,
  });
  credentials.add(secondConnection.wsEndpoint);
  broker.setConnected(false);
  await delay(150);
  await refused(secondConnection.wsEndpoint);
  broker.setConnected(true);
  const refreshed = await until(async () => {
    const { instances } = await api.listInstances({ hostId: scope.hostId });
    return (
      instances.find(
        (entry) =>
          entry.instanceId === scope.instanceId &&
          entry.generation !== scope.generation,
      ) ?? null
    );
  }, "native reconnect changed generation");
  await assert.rejects(api.listTabs(scope));
  const newScope = { ...scope, generation: refreshed.generation };
  const refreshedTabs = await api.listTabs(newScope);
  assert.equal(refreshedTabs.tabs[0]?.tabId, tab.tabId);
  assert.equal(refreshedTabs.tabs[0]?.control, null);
  await until(async () => {
    const row = getStoredThreadTabs(server.db, scope.threadId);
    if (!row) return null;
    const persisted = threadTabsSchema
      .parse(JSON.parse(row.tabsJson))
      .find((value) => value.id === tab.tabId);
    return persisted?.kind === "browser" &&
      persisted.desktopTarget?.generation === refreshed.generation
      ? true
      : null;
  }, "reconnect snapshot refreshed persisted generation");
  await api.closeTab({ ...newScope, tabId: tab.tabId });
  steps.push(
    "daemon disconnect revokes native lease, stale generation fails, reconnect updates persistence",
  );
  succeeded = true;
} catch (error) {
  const message = redact(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  await writeFile(join(config.artifacts, "failure.txt"), message);
  console.error(message);
  process.exitCode = 1;
} finally {
  if (devStarted)
    await run(config.devBrowser, ["stop"], childEnv).catch(() => {});
  broker.setConnected(false);
  responder.unregister();
  await broker.close();
  await writeFile(join(config.artifacts, "stop-electron"), "stop");
  await Promise.race([electronExited, delay(5e3)]);
  if (electron.exitCode === null) killElectronGroup();
  const daemonLog = join(config.artifacts, "dev-browser-state/daemon.log");
  const daemonText = await readFile(daemonLog, "utf8").catch(() => null);
  if (daemonText !== null)
    await writeFile(daemonLog, redact(daemonText), { mode: 0o600 });
  await writeFile(
    join(config.artifacts, "electron.log"),
    redact(Buffer.concat(electronOutput).toString()),
  );
  await new Promise((resolve) => browserServer.close(() => resolve()));
  await server.close();
  await writeFile(
    join(config.artifacts, "result.json"),
    JSON.stringify(
      {
        passed: succeeded,
        steps,
        devBrowserSource: config.source,
        devBrowserVersion: devBrowserVersion.trim(),
        devBrowserSha256: config.checksum,
        transport:
          "Real SDK/CLI HTTP, daemon broker WS, Electron main client/native views; registerHostRpcResponder substitutes only server-to-daemon WS",
        storage:
          "Migrated in-memory SQLite and isolated temporary desktop data",
        cleanupCompleted: true,
        artifacts: config.artifacts,
      },
      null,
      2,
    ),
  );
}
