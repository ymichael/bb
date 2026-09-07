import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, nativeImage } from "electron";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { desktopBrowserResultSchemas } from "@bb/host-daemon-contract";
import {
  createDesktopBrowserCdpBridge,
  desktopBrowserCdpTargetId,
  type DesktopBrowserCdpScope,
} from "../../src/desktop-browser-cdp.js";
import { createDesktopBrowserCdpAdapter } from "../../src/desktop-browser-cdp-adapter.js";
import { createDesktopBrowserViewManager } from "../../src/desktop-browser-view.js";
import { createDesktopBrowserBroker } from "../../src/desktop-browser-broker.js";

const execute = promisify(execFile);
const keepAlive = setInterval(() => {}, 1000);
app.once("quit", () => clearInterval(keepAlive));
const objectSchema = z.record(z.string(), z.json());
type CdpObject = z.infer<typeof objectSchema>;
const configSchema = z.object({
  artifacts: z.string().min(1),
  devBrowser: z.string().min(1),
  devBrowserSource: z.enum(["release", "local"]),
  agentBrowser: z.string().min(1),
});
const targetListSchema = z.object({
  targetInfos: z.array(
    z.object({ targetId: z.string(), type: z.string(), url: z.string() }),
  ),
});
const responseSchema = z.object({
  id: z.number().optional(),
  result: objectSchema.optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
});

async function connectRaw(endpoint: string) {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  return {
    socket,
    command(method: string, params: CdpObject = {}, sessionId?: string) {
      const requestId = ++id;
      return new Promise<CdpObject>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`Timed out: ${method}`)),
          10_000,
        );
        const onClose = () => finish(new Error(`Connection closed: ${method}`));
        const onMessage = (data: Buffer) => {
          const response = responseSchema.parse(JSON.parse(data.toString()));
          if (response.id !== requestId) return;
          finish(
            response.error
              ? new Error(`${method}: ${response.error.message}`)
              : null,
            response.result,
          );
        };
        function finish(error: Error | null, result: CdpObject = {}) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          socket.off("close", onClose);
          if (error) reject(error);
          else resolve(result);
        }
        socket.on("message", onMessage);
        socket.once("close", onClose);
        socket.send(
          JSON.stringify({ id: requestId, method, params, sessionId }),
        );
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.close();
      });
    },
  };
}

async function main() {
  const configPath = z.string().parse(process.argv.at(-1));
  const config = configSchema.parse(
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  app.setPath("userData", join(config.artifacts, "electron-profile"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("site-per-process");
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const tracePath = join(config.artifacts, "cdp.jsonl");
  const methods = new Set<string>();
  let sawIframeTarget = false;
  function trace(direction: string, method: string, detail: CdpObject = {}) {
    if (direction === "command") methods.add(method);
    appendFileSync(
      tracePath,
      JSON.stringify({ direction, method, ...detail }) + "\n",
    );
  }
  const fixtureServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/private") {
      response.end(
        '<title>Other thread sentinel</title><h1>PRIVATE_THREAD_SENTINEL</h1><iframe src="/child" width="800" height="500"></iframe>',
      );
      return;
    }
    if (request.url === "/frames") {
      response.end(
        '<title>Frame fixture</title><iframe src="/child" width="800" height="500"></iframe>',
      );
      return;
    }
    if (request.url === "/nested") {
      response.end(
        '<title>Nested frame fixture</title><iframe src="/frames" style="margin:900px 0 0 120px;border:7px solid" width="800" height="500"></iframe>',
      );
      return;
    }
    if (request.url === "/cross") {
      response.end(
        `<title>Cross-origin frame fixture</title><iframe src="http://localhost:${fixturePort}/child" style="margin:80px;border:5px solid" width="650" height="400"></iframe>`,
      );
      return;
    }
    if (request.url === "/child") {
      response.end(
        "<button onclick=\"this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);this.dataset.trusted=String(event.isTrusted);document.querySelector('#frame-result').textContent='Frame clicked'\">Frame action</button><p id=\"frame-result\">Waiting</p>",
      );
      return;
    }
    response.end(`<!doctype html><title>Browser CDP smoke</title>
      <style>body{font:20px sans-serif;padding:24px}input,button{font:inherit;margin:12px}</style>
      <h1>CDP fixture</h1><label>Name <input id="name"></label>
      <button id="submit">Submit</button><p id="result">Waiting</p>
      <script>document.querySelector('#submit').onclick=()=>{
        document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value;
      };</script>`);
  });
  await new Promise<void>((resolve) =>
    fixtureServer.listen(0, "127.0.0.1", resolve),
  );
  const address = fixtureServer.address();
  assert(address !== null && typeof address !== "string");
  const fixturePort = address.port;
  const url = `http://127.0.0.1:${fixturePort}`;
  const window = new BrowserWindow({ width: 1000, height: 800, show: true });
  await window.loadURL(
    "data:text/html,<title>Trusted app sentinel</title>TRUSTED_APP_SENTINEL",
  );
  const manager = createDesktopBrowserViewManager({
    partition: `smoke-${randomBytes(12).toString("hex")}`,
    dispatchAppCommand: () => {},
    focusHostWebContents: () => {},
    resolveAppCommand: () => null,
  });
  const scopeA = {
    hostWebContentsId: window.webContents.id,
    threadId: "smoke-thread-a",
  };
  const scopeB = {
    hostWebContentsId: window.webContents.id,
    threadId: "smoke-thread-b",
  };
  const bounds = { x: 0, y: 0, width: 960, height: 720 };
  function addTab(scope: DesktopBrowserCdpScope, targetUrl: string) {
    assert.equal(scope.hostWebContentsId, window.webContents.id);
    const tabId = `browser-smoke-${randomBytes(8).toString("hex")}`;
    manager.attach({
      hostWindow: window,
      request: {
        tabId,
        threadId: scope.threadId,
        url: targetUrl,
        bounds,
        visible: scope.threadId === scopeA.threadId,
      },
    });
    return tabId;
  }
  const originalTab = addTab(scopeA, `${url}/existing`);
  const privateTab = addTab(scopeB, `${url}/private`);
  const originalTarget = desktopBrowserCdpTargetId(scopeA, originalTab);
  const privateTarget = desktopBrowserCdpTargetId(scopeB, privateTab);
  const adapter = createDesktopBrowserCdpAdapter({
    manager,
    async createTab(scope, targetUrl, signal) {
      signal.throwIfAborted();
      return addTab(scope, targetUrl);
    },
    async closeTab(scope, tabId, signal) {
      signal.throwIfAborted();
      assert(
        manager.getAutomationTabs(scope).some((tab) => tab.tabId === tabId),
      );
      manager.detach({ hostWindow: window, tabId });
    },
    async activateTab(scope, tabId, signal) {
      signal.throwIfAborted();
      assert(
        manager.getAutomationTabs(scope).some((tab) => tab.tabId === tabId),
      );
      manager.focus({ hostWindow: window, tabId });
    },
  });
  const bridge = await createDesktopBrowserCdpBridge({
    adapter,
    product: `Chrome/${process.versions.chrome}`,
  });
  const grant = bridge.grant(scopeA, Date.now() + 180_000);
  const privateGrant = bridge.grant(scopeB, Date.now() + 180_000);
  const proxy = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    maxPayload: 16 * 1024 * 1024,
  });
  await new Promise<void>((resolve) => proxy.once("listening", resolve));
  const proxyAddress = proxy.address();
  assert(proxyAddress !== null && typeof proxyAddress !== "string");
  const proxyToken = randomBytes(32).toString("hex");
  const endpoint = `ws://127.0.0.1:${proxyAddress.port}/${proxyToken}`;
  const upstreams = new Set<WebSocket>();
  let proxyUpstreamEndpoint = grant.endpoint;
  const disconnectListeners = new Set<() => void>();
  async function waitForDisconnect() {
    if (upstreams.size === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        disconnectListeners.delete(check);
        reject(new Error("Controller did not disconnect within 5 seconds"));
      }, 5000);
      function check() {
        if (upstreams.size !== 0) return;
        clearTimeout(timer);
        disconnectListeners.delete(check);
        resolve();
      }
      disconnectListeners.add(check);
      check();
    });
  }
  proxy.on("connection", (client, request) => {
    if (request.url !== `/${proxyToken}`) {
      client.close();
      return;
    }
    const upstream = new WebSocket(proxyUpstreamEndpoint);
    upstreams.add(upstream);
    const requests = new Map<number, string>();
    const queued: Buffer[] = [];
    upstream.on("open", () => {
      for (const data of queued) upstream.send(data, { binary: false });
      queued.length = 0;
    });
    client.on("message", (data) => {
      const bytes = Buffer.from(data.toString());
      const command = z
        .object({
          id: z.number(),
          method: z.string(),
          params: objectSchema.optional(),
          sessionId: z.string().optional(),
        })
        .parse(JSON.parse(bytes.toString()));
      requests.set(command.id, command.method);
      trace("command", command.method, {
        id: command.id,
        sessionId: command.sessionId ?? "",
        ...(command.method.startsWith("Target.")
          ? { params: command.params ?? {} }
          : {}),
        ...(command.method === "Runtime.callFunctionOn" &&
        typeof command.params?.functionDeclaration === "string"
          ? { function: command.params.functionDeclaration.slice(0, 1200) }
          : {}),
      });
      if (upstream.readyState === WebSocket.OPEN)
        upstream.send(bytes, { binary: false });
      else queued.push(bytes);
    });
    upstream.on("message", (data) => {
      const message = objectSchema.parse(JSON.parse(data.toString()));
      if (message.method === "Target.attachedToTarget") {
        const info = z
          .object({
            params: z.object({ targetInfo: z.object({ type: z.string() }) }),
          })
          .safeParse(message);
        if (info.success && info.data.params.targetInfo.type === "iframe")
          sawIframeTarget = true;
      }
      const method =
        typeof message.method === "string"
          ? message.method
          : typeof message.id === "number"
            ? (requests.get(message.id) ?? "reply")
            : "reply";
      if (typeof message.id === "number") requests.delete(message.id);
      trace("response", method, {
        id: message.id ?? null,
        error: message.error ?? null,
        sessionId: message.sessionId ?? "",
        ...(method.startsWith("Target.")
          ? { result: message.result ?? null, params: message.params ?? null }
          : {}),
      });
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    upstream.on("error", () => client.close());
    upstream.on("close", () => {
      upstreams.delete(upstream);
      client.close();
      for (const listener of disconnectListeners) listener();
    });
    client.on("close", () => upstream.close());
    client.on("error", () => upstream.close());
  });
  const clientEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    DEV_BROWSER_HOME: join(config.artifacts, "dev-state"),
    AGENT_BROWSER_SOCKET_DIR: join(config.artifacts, "agent-state"),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000",
    AGENT_BROWSER_DEFAULT_TIMEOUT: "10000",
  };
  const agentArgs = [
    "--session",
    "cdp-smoke",
    "--config",
    join(config.artifacts, "agent-config.json"),
  ];
  const sensitiveEndpoints = new Set([endpoint, grant.endpoint]);
  function redact(value: string) {
    for (const sensitive of sensitiveEndpoints)
      value = value.replaceAll(sensitive, "<scoped-cdp>");
    return value;
  }
  let devRunning = false;
  let agentRunning = false;
  async function run(binary: string, args: string[]) {
    if (binary === config.devBrowser && args.includes("--connect"))
      devRunning = true;
    if (binary === config.agentBrowser && args.includes("--cdp"))
      agentRunning = true;
    try {
      const result = await execute(binary, args, {
        env: clientEnvironment,
        cwd: config.artifacts,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (binary === config.devBrowser && args[0] === "stop")
        devRunning = false;
      if (binary === config.agentBrowser && args.at(-1) === "close")
        agentRunning = false;
      return result.stdout;
    } catch (error) {
      const output = z.object({ stderr: z.string() }).safeParse(error);
      throw new Error(
        redact(
          output.success && output.data.stderr.length > 0
            ? output.data.stderr
            : error instanceof Error
              ? error.message
              : String(error),
        ).slice(-6000),
      );
    }
  }
  const checks: string[] = [];
  function passed(name: string) {
    checks.push(name);
    console.log(`PASS ${name}`);
  }
  const broker = createDesktopBrowserBroker({
    manager,
    product: `Chrome/${process.versions.chrome}`,
  });
  try {
    assert.match(
      await run(config.devBrowser, ["--version"]),
      config.devBrowserSource === "release"
        ? /^dev-browser 1\.0\.0-rc\.2\s*$/
        : /^dev-browser \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/,
    );
    assert.match(await run(config.agentBrowser, ["--version"]), /0\.36\.0/);
    passed(
      config.devBrowserSource === "release"
        ? "pinned client versions"
        : "local DevBrowser version and pinned agent-browser version",
    );
    const privateClient = await connectRaw(privateGrant.endpoint);
    const privateTargets = targetListSchema.parse(
      await privateClient.command("Target.getTargets"),
    );
    assert(
      privateTargets.targetInfos.some(
        (target) => target.targetId === privateTarget,
      ),
    );
    assert(
      !privateTargets.targetInfos.some(
        (target) => target.targetId === originalTarget,
      ),
    );
    await assert.rejects(
      privateClient.command("Target.attachToTarget", {
        targetId: originalTarget,
        flatten: true,
      }),
    );
    await privateClient.close();
    const raw = await connectRaw(endpoint);
    const targets = targetListSchema.parse(
      await raw.command("Target.getTargets"),
    );
    assert(
      targets.targetInfos.some((target) => target.targetId === originalTarget),
    );
    assert(
      !targets.targetInfos.some(
        (target) =>
          target.targetId === privateTarget || target.url.startsWith("data:"),
      ),
    );
    await assert.rejects(
      raw.command("Target.closeTarget", { targetId: privateTarget }),
    );
    await assert.rejects(raw.command("Browser.close"));
    await raw.close();
    await waitForDisconnect();
    passed(
      "two thread scopes exclude each other and trusted renderer; forbidden close rejected",
    );
    const devScript = `
      const pages = await browser.listPages();
      if (pages.length !== 1 || pages[0].id !== ${JSON.stringify(originalTarget)}) throw new Error('Unexpected discovery: '+JSON.stringify(pages));
      const page = await browser.getPage(${JSON.stringify(originalTarget)});
      await page.goto(${JSON.stringify(`${url}/dev-browser`)});
      const snapshot = await page.snapshot({interactive:true});
      const button = snapshot.split('\\n').find(line => line.includes('Submit'));
      const ref = button && button.match(/ref=(e\\d+)/)?.[1];
      if (!ref) throw new Error('Missing button ref: '+snapshot);
      await page.fill('#name','DevBrowser');
      await page.click('ref/'+ref);
      if (await page.$eval('#result', node => node.textContent) !== 'Hello DevBrowser') throw new Error('Input/click failed');
      await page.shot({name:'dev-browser.png'});
      const extra = await browser.newPage();
      for (const route of ['/frames','/nested']) {
        await extra.goto(${JSON.stringify(url)}+route, {waitUntil:'load'});
        const frameSnapshot = await extra.snapshot({interactive:true});
        const frameButton = frameSnapshot.split('\\n').find(line => line.includes('Frame action'));
        const frameRef = frameButton && frameButton.match(/ref=(f\\d+e\\d+)/)?.[1];
        if (!frameRef) throw new Error('Missing iframe ref: '+frameSnapshot);
        const frame = extra.frames().find(frame=>frame.url().endsWith('/child'));
        if (!frame) throw new Error('Missing child frame');
        await frame.$eval('button', node => {
          node.addEventListener('click', event => node.dataset.trusted = String(event.isTrusted));
        });
        await extra.click('ref/'+frameRef);
        await frame.waitForFunction(() => document.querySelector('#frame-result').textContent === 'Frame clicked' && document.querySelector('button').dataset.trusted === 'true');
        await extra.shot({name:route.slice(1)+'.png'});
      }
      await extra.goto(${JSON.stringify(`${url}/cross`)}, {waitUntil:'load'});
      const crossFrame = extra.frames().find(frame=>frame.url().includes('localhost:'));
      if (!crossFrame) throw new Error('Missing cross-origin frame');
      await crossFrame.$eval('button', node => {
        node.addEventListener('click', event => node.dataset.trusted = String(event.isTrusted));
      });
      if (${JSON.stringify(config.devBrowserSource === "local")}) {
        const findRef = async () => {
          const tree = await extra.snapshot({interactive:true});
          const line = tree.split('\\n').find(line=>line.includes('Frame action'));
          const ref = line?.match(/ref=(f\\d+e\\d+)/)?.[1];
          if (!ref) throw new Error('Missing cross-origin ref: '+tree);
          return ref;
        };
        const assertStale = async ref => {
          const liveFrame = extra.frames().find(frame=>frame.url().endsWith('/child'));
          const before = liveFrame ? await liveFrame.$eval('button',node=>node.dataset.clicks||'0') : null;
          let rejected = false;
          try { await extra.click('ref/'+ref); } catch (error) {
            if (!/stale|gone|snapshot/i.test(String(error))) throw error;
            rejected = true;
          }
          if (!rejected) throw new Error('Stale iframe ref still acts: '+ref);
          if (liveFrame && await liveFrame.$eval('button',node=>node.dataset.clicks||'0') !== before) throw new Error('Stale ref caused a click before rejecting');
        };
        let currentRef = await findRef();
        await extra.click('ref/'+currentRef);
        for (const destination of [crossFrame.url(), ${JSON.stringify(`${url}/child`)}, crossFrame.url()]) {
          const previousRef = currentRef;
          const frame = extra.frames().find(frame=>frame.parentFrame()===extra.mainFrame());
          if (!frame) throw new Error('Missing frame during navigation');
          await extra.$eval('iframe',(node,destination)=>new Promise(resolve=>{node.addEventListener('load',resolve,{once:true});node.src=destination;}),destination);
          currentRef = await findRef();
          if (currentRef === previousRef) throw new Error('Ref reused across frame document replacement');
          await assertStale(previousRef);
          await extra.click('ref/'+currentRef);
          const liveFrame = extra.frames().find(frame=>frame.url()===destination);
          if (!liveFrame) throw new Error('Missing replacement frame');
          await liveFrame.waitForFunction(()=>document.querySelector('#frame-result').textContent==='Frame clicked' && document.querySelector('button').dataset.trusted==='true');
        }
        const previousRef = currentRef;
        await extra.$eval('iframe',node=>node.remove());
        await assertStale(previousRef);
        await extra.goto(${JSON.stringify(`${url}/cross`)},{waitUntil:'load'});
        currentRef = await findRef();
        await assertStale(previousRef);
        const validBeforeParentNavigation = currentRef;
        await extra.goto(${JSON.stringify(`${url}/cross`)},{waitUntil:'load'});
        currentRef = await findRef();
        if (currentRef === validBeforeParentNavigation) throw new Error('Ref reused across parent navigation');
        await assertStale(validBeforeParentNavigation);
        const live = extra.frames().find(frame=>frame.url().includes('localhost:'));
        await live.$eval('button',node=>node.addEventListener('click',event=>node.dataset.trusted=String(event.isTrusted)));
        await extra.click('ref/'+currentRef);
      } else {
        await crossFrame.click('button');
      }
      const finalCrossFrame = extra.frames().find(frame=>frame.url().includes('localhost:'));
      await finalCrossFrame.waitForFunction(() => document.querySelector('#frame-result').textContent === 'Frame clicked' && document.querySelector('button').dataset.trusted === 'true');
      await extra.shot({name:'cross-origin.png'});
      await extra.close();
      if ((await browser.listPages()).length !== 1) throw new Error('Close did not remove target');
      'DEV_BROWSER_OK';
    `;
    assert.match(
      await run(config.devBrowser, [
        "--connect",
        endpoint,
        "-t",
        "25",
        "-e",
        devScript,
      ]),
      /DEV_BROWSER_OK/,
    );
    assert(
      sawIframeTarget,
      "Cross-origin frame must exercise a native child CDP session",
    );
    const devImage = nativeImage.createFromPath(
      join(config.artifacts, "dev-state/tmp/dev-browser.png"),
    );
    assert(!devImage.isEmpty());
    assert(devImage.getSize().width > 100);
    passed(
      "DevBrowser discovery, navigation, snapshot refs, fill, click, screenshot, same-origin/nested trusted ref clicks, cross-origin frame click, create and close",
    );
    if (config.devBrowserSource === "local")
      passed(
        "cross-origin snapshot ref clicks and stale refs across reload, origin swaps, removal, and parent navigation",
      );
    assert(
      manager
        .getAutomationTabs(scopeA)
        .some((tab) => tab.webContents.debugger.isAttached()),
    );
    const hiddenClient = await connectRaw(privateGrant.endpoint);
    const { sessionId: hiddenSession } = z
      .object({ sessionId: z.string() })
      .parse(
        await hiddenClient.command("Target.attachToTarget", {
          targetId: privateTarget,
          flatten: true,
        }),
      );
    await hiddenClient.command("Runtime.enable", {}, hiddenSession);
    const hiddenResult = await hiddenClient.command(
      "Runtime.evaluate",
      {
        expression:
          "document.querySelector('h1').textContent += '_CONTROLLED'; ({title:document.title,text:document.querySelector('h1').textContent})",
        returnByValue: true,
      },
      hiddenSession,
    );
    assert.deepEqual(
      z
        .object({ result: z.object({ value: objectSchema }) })
        .parse(hiddenResult).result.value,
      {
        title: "Other thread sentinel",
        text: "PRIVATE_THREAD_SENTINEL_CONTROLLED",
      },
    );
    const hiddenPoint = z
      .object({
        result: z.object({ value: z.object({ x: z.number(), y: z.number() }) }),
      })
      .parse(
        await hiddenClient.command(
          "Runtime.evaluate",
          {
            expression: `(() => {
          const frame = document.querySelector('iframe');
          const button = frame.contentDocument.querySelector('button');
          button.addEventListener('click', event => button.dataset.trusted = String(event.isTrusted));
          const outer = frame.getBoundingClientRect();
          const inner = button.getBoundingClientRect();
          return {x:outer.x + frame.clientLeft + inner.x + inner.width/2, y:outer.y + frame.clientTop + inner.y + inner.height/2};
        })()`,
            returnByValue: true,
          },
          hiddenSession,
        ),
      ).result.value;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await hiddenClient.command(
        "Input.dispatchMouseEvent",
        { type, ...hiddenPoint, button: "left", clickCount: 1 },
        hiddenSession,
      );
    }
    const hiddenClicked = await hiddenClient.command(
      "Runtime.evaluate",
      {
        expression:
          "document.querySelector('iframe').contentDocument.querySelector('button').dataset.trusted",
        returnByValue: true,
      },
      hiddenSession,
    );
    assert.equal(
      z.object({ result: z.object({ value: z.string() }) }).parse(hiddenClicked)
        .result.value,
      "true",
    );
    const hiddenScreenshot = z
      .object({ data: z.string() })
      .parse(
        await hiddenClient.command(
          "Page.captureScreenshot",
          { format: "png" },
          hiddenSession,
        ),
      );
    const hiddenBytes = Buffer.from(hiddenScreenshot.data, "base64");
    assert(!nativeImage.createFromBuffer(hiddenBytes).isEmpty());
    await writeFile(join(config.artifacts, "hidden-thread.png"), hiddenBytes);
    await hiddenClient.close();
    assert(
      manager
        .getAutomationTabs(scopeA)
        .some((tab) => tab.webContents.debugger.isAttached()),
    );
    passed(
      "simultaneous thread controllers click a hidden B iframe and capture it while DevBrowser controls A",
    );
    await run(config.devBrowser, ["stop"]);
    await waitForDisconnect();
    assert(
      manager
        .getAutomationTabs(scopeA)
        .some((tab) => tab.tabId === originalTab),
    );
    assert.match(
      await run(config.devBrowser, [
        "--connect",
        endpoint,
        "-t",
        "15",
        "-e",
        `const p=await browser.getPage(${JSON.stringify(originalTarget)});await p.$eval('#result',n=>n.textContent)`,
      ]),
      /Hello DevBrowser/,
    );
    await run(config.devBrowser, ["stop"]);
    await waitForDisconnect();
    passed("DevBrowser disconnect and reconnect preserve user tab and state");
    const agent = (args: string[]) =>
      run(config.agentBrowser, [...agentArgs, "--cdp", endpoint, ...args]);
    await agent(["open", `${url}/agent-browser`]);
    const snapshot = await agent(["snapshot", "-i"]);
    const button = snapshot.split("\n").find((line) => line.includes("Submit"));
    const ref = button?.match(/ref=(e\d+)/)?.[1];
    assert(ref, `Missing agent-browser button ref: ${snapshot}`);
    await agent(["fill", "#name", "AgentBrowser"]);
    await agent(["click", `@${ref}`]);
    assert.match(await agent(["get", "text", "#result"]), /Hello AgentBrowser/);
    const screenshot = join(config.artifacts, "agent-browser.png");
    await agent(["screenshot", screenshot]);
    assert(!nativeImage.createFromPath(screenshot).isEmpty());
    await agent(["tab", "new", `${url}/agent-new`]);
    assert.equal(manager.getAutomationTabs(scopeA).length, 2);
    await agent(["tab", "close"]);
    assert.equal(manager.getAutomationTabs(scopeA).length, 1);
    await agent(["close"]);
    await waitForDisconnect();
    assert(
      manager
        .getAutomationTabs(scopeA)
        .some((tab) => tab.tabId === originalTab),
    );
    assert.match(await agent(["get", "text", "#result"]), /Hello AgentBrowser/);
    await agent(["close"]);
    await waitForDisconnect();
    passed(
      "agent-browser navigation, snapshot refs, input, screenshot, create, close and reconnect",
    );
    const revocable = await connectRaw(endpoint);
    await revocable.command("Target.getTargets");
    const disconnected = new Promise<void>((resolve) =>
      revocable.socket.once("close", resolve),
    );
    grant.revoke();
    await disconnected;
    assert.equal(manager.getAutomationTabs(scopeA).length, 1);
    assert.equal(manager.getAutomationTabs(scopeB).length, 1);
    passed(
      "revocation disconnects controller and preserves both threads' tabs",
    );
    broker.registerWindow(window);
    broker.setHostId("smoke-host");
    const instance = broker.listInstances()[0];
    assert(instance);
    const target = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId: "smoke-broker-thread",
    };
    const brokerTabId = "browser:smoke-broker:none";
    const { tab: brokerTab } = desktopBrowserResultSchemas[
      "desktop.browser.create_tab"
    ].parse(
      await broker.execute({
        type: "desktop.browser.create_tab",
        ...target,
        tabId: brokerTabId,
        url: `${url}/broker`,
        profile: { kind: "automation", id: "smoke-broker-profile" },
        presentation: "hidden",
      }),
    );
    assert.equal(brokerTab.presentation, "hidden");
    assert.deepEqual(brokerTab.profile, {
      kind: "automation",
      id: "smoke-broker-profile",
    });
    const brokerScope = {
      hostWebContentsId: window.webContents.id,
      threadId: target.threadId,
    };
    const brokerPage = manager
      .getAutomationTabs(brokerScope)
      .find((tab) => tab.tabId === brokerTabId);
    assert(brokerPage);
    assert.notEqual(
      brokerPage.webContents.session,
      manager.getAutomationTabs(scopeA)[0]?.webContents.session,
    );
    if (
      brokerPage.webContents.isLoading() ||
      brokerPage.webContents.getURL() !== `${url}/broker`
    ) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          brokerPage.webContents.off("did-finish-load", loaded);
          reject(new Error("Broker hidden tab did not load within 5 seconds"));
        }, 5000);
        function loaded() {
          clearTimeout(timer);
          resolve();
        }
        brokerPage.webContents.once("did-finish-load", loaded);
      });
    }
    let hiddenCaptureError: Error | null = null;
    try {
      const capture = desktopBrowserResultSchemas[
        "desktop.browser.capture_tab"
      ].parse(
        await broker.execute({
          type: "desktop.browser.capture_tab",
          ...target,
          tabId: brokerTabId,
        }),
      );
      const captureBytes = Buffer.from(capture.base64, "base64");
      const captureImage = nativeImage.createFromBuffer(captureBytes);
      assert(!captureImage.isEmpty());
      assert.deepEqual(captureImage.getSize(), {
        width: capture.width,
        height: capture.height,
      });
      await writeFile(
        join(config.artifacts, "broker-hidden.jpg"),
        captureBytes,
      );
    } catch (error) {
      hiddenCaptureError = new Error(
        `Broker hidden capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(hiddenCaptureError.message);
    }
    await assert.rejects(
      broker.execute({
        type: "desktop.browser.capture_tab",
        ...target,
        threadId: scopeA.threadId,
        tabId: brokerTabId,
      }),
    );
    await assert.rejects(
      broker.execute({
        type: "desktop.browser.list_tabs",
        ...target,
        generation: "stale-generation",
      }),
    );
    passed(
      "broker creates hidden automation tab in isolated profile; rejects wrong thread and stale instance",
    );
    async function acquireBroker(leaseId: string) {
      await broker.execute({
        type: "desktop.browser.acquire_control",
        ...target,
        leaseId,
        tabIds: [brokerTabId],
        controllerLabel: "Electron smoke",
        expiresAt: Date.now() + 60_000,
      });
      const connection = desktopBrowserResultSchemas[
        "desktop.browser.open_connection"
      ].parse(
        await broker.execute({
          type: "desktop.browser.open_connection",
          ...target,
          leaseId,
          tabIds: [brokerTabId],
        }),
      );
      sensitiveEndpoints.add(connection.wsEndpoint);
      return connection;
    }
    const firstLease = "smoke-broker-control-first";
    const firstConnection = await acquireBroker(firstLease);
    await waitForDisconnect();
    proxyUpstreamEndpoint = firstConnection.wsEndpoint;
    assert.equal(
      broker.getControl(window.webContents.id, brokerTabId)?.control?.leaseId,
      firstLease,
    );
    const brokerTargetId = desktopBrowserCdpTargetId(brokerScope, brokerTabId);
    const brokerScript = `
      const pages = await browser.listPages();
      if (pages.length !== 1 || pages[0].id !== ${JSON.stringify(brokerTargetId)}) throw new Error('Broker leaked targets');
      const page = await browser.getPage(${JSON.stringify(brokerTargetId)});
      await page.goto(${JSON.stringify(`${url}/broker-control`)});
      await page.fill('#name', 'Broker');
      await page.click('#submit');
      if (await page.$eval('#result', node => node.textContent) !== 'Hello Broker') throw new Error('Broker input failed');
      await page.shot({name:'broker-cdp.png'});
      const extra = await browser.newPage();
      await extra.goto(${JSON.stringify(`${url}/broker-created`)});
      if ((await browser.listPages()).length !== 2) throw new Error('Broker page creation failed');
      await extra.close();
      if ((await browser.listPages()).length !== 1) throw new Error('Broker page close failed');
      'BROKER_CDP_OK';
    `;
    assert.match(
      await run(config.devBrowser, [
        "--connect",
        endpoint,
        "-t",
        "20",
        "-e",
        brokerScript,
      ]),
      /BROKER_CDP_OK/,
    );
    assert(brokerPage.webContents.debugger.isAttached());
    broker.takeOver(window.webContents.id, brokerTabId);
    assert.equal(
      broker.getControl(window.webContents.id, brokerTabId)?.control,
      null,
    );
    assert(!brokerPage.webContents.debugger.isAttached());
    await assert.rejects(
      broker.execute({
        type: "desktop.browser.open_connection",
        ...target,
        leaseId: firstLease,
        tabIds: [brokerTabId],
      }),
    );
    await run(config.devBrowser, ["stop"]);
    await waitForDisconnect();
    const secondLease = "smoke-broker-control-second";
    const secondConnection = await acquireBroker(secondLease);
    proxyUpstreamEndpoint = secondConnection.wsEndpoint;
    assert.notEqual(secondConnection.wsEndpoint, firstConnection.wsEndpoint);
    assert.match(
      await run(config.devBrowser, [
        "--connect",
        endpoint,
        "-t",
        "15",
        "-e",
        `const page = await browser.getPage(${JSON.stringify(brokerTargetId)}); await page.$eval('#result', node => node.textContent)`,
      ]),
      /Hello Broker/,
    );
    await run(config.devBrowser, ["stop"]);
    await broker.execute({
      type: "desktop.browser.release_control",
      ...target,
      leaseId: secondLease,
    });
    assert.equal(
      broker.getControl(window.webContents.id, brokerTabId)?.control,
      null,
    );
    assert.equal(manager.getAutomationTabs(brokerScope).length, 1);
    await broker.execute({
      type: "desktop.browser.close_tab",
      ...target,
      tabId: brokerTabId,
    });
    assert.equal(manager.getAutomationTabs(brokerScope).length, 0);
    passed(
      "broker lease connects RC2, creates and closes pages, revokes on takeover, reacquires preserved state, releases and closes tab",
    );
    if (hiddenCaptureError) throw hiddenCaptureError;
    passed(
      "broker captures newly loaded hidden automation tab before any CDP attachment",
    );
  } finally {
    trace("cleanup", "clients");
    if (devRunning) await run(config.devBrowser, ["stop"]).catch(() => {});
    if (agentRunning)
      await run(config.agentBrowser, [...agentArgs, "close"]).catch(() => {});
    grant.revoke();
    privateGrant.revoke();
    for (const upstream of upstreams) upstream.terminate();
    for (const client of proxy.clients) client.terminate();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    trace("cleanup", "bridge");
    await bridge.close();
    broker.dispose();
    trace("cleanup", "views");
    manager.destroyAll();
    window.destroy();
    trace("cleanup", "fixture-server");
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    trace("cleanup", "complete");
  }
  writeFileSync(
    join(config.artifacts, "result.json"),
    JSON.stringify(
      {
        checks,
        methods: [...methods].sort(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        cleanupCompleted: true,
        limitations:
          config.devBrowserSource === "release"
            ? [
                "RC2 snapshots omit cross-origin frame contents; frame selectors work. Popup control is not covered.",
              ]
            : [
                "Local DevBrowser build with cross-origin refs; not a published release. Popup control is not covered.",
              ],
      },
      null,
      2,
    ),
  );
  console.log("BB_CDP_SMOKE_COMPLETE");
  app.quit();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  console.log("BB_CDP_SMOKE_FAILED");
  app.exit(1);
});
