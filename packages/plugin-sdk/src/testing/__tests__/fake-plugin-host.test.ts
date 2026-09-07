import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type PluginAgentConfigurationContext,
  type PluginAgentToolPresentation,
} from "../../backend-contract.js";
import { defineRpcContract } from "../../rpc-contract.js";
import {
  parsePluginAgentToolPresentation,
  PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS,
  RESERVED_BB_CLI_COMMANDS,
} from "../../internal/host-policy.js";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "../index.js";

describe("fixtures", () => {
  it("derives linked dispatch identities unless explicitly overridden", () => {
    const inherited = makeMessageDispatchHookContext({
      project: { id: "project-target" },
      environment: { id: "environment-target" },
      host: { id: "host-target" },
    });
    const explicit = makeMessageDispatchHookContext({
      project: { id: "project-target" },
      environment: {
        id: "environment-target",
        projectId: "environment-project-explicit",
        hostId: "environment-host-explicit",
      },
      host: { id: "host-target" },
      thread: {
        projectId: "thread-project-explicit",
        environmentId: "thread-environment-explicit",
      },
    });

    expect(inherited.thread.projectId).toBe("project-target");
    expect(inherited.thread.environmentId).toBe("environment-target");
    expect(inherited.environment?.projectId).toBe("project-target");
    expect(inherited.environment?.hostId).toBe("host-target");
    expect(explicit.thread.projectId).toBe("thread-project-explicit");
    expect(explicit.thread.environmentId).toBe("thread-environment-explicit");
    expect(explicit.environment?.projectId).toBe(
      "environment-project-explicit",
    );
    expect(explicit.environment?.hostId).toBe("environment-host-explicit");
  });

  it("keeps queued messages on the dispatch context thread by default", () => {
    const inherited = makeMessageDispatchHookContext({
      thread: { id: "thread-target" },
      queuedMessage: { id: "queued-target" },
    });
    const explicit = makeMessageDispatchHookContext({
      thread: { id: "thread-target" },
      queuedMessage: { threadId: "thread-explicit" },
    });

    expect(inherited.queuedMessage?.threadId).toBe("thread-target");
    expect(explicit.queuedMessage?.threadId).toBe("thread-explicit");
  });
});

describe("server", () => {
  it("serves the configured public app URL and defaults to null", () => {
    const configured = createFakePluginHost({
      appUrl: "https://bb.example.test",
    });
    const unset = createFakePluginHost();

    expect(configured.bb.server.experimental_appUrl).toBe(
      "https://bb.example.test",
    );
    expect(unset.bb.server.experimental_appUrl).toBeNull();
  });
});

describe("ui.requestInput", () => {
  it("settles a blocking request through the harness", async () => {
    const { bb, harness } = createFakePluginHost();
    const pending = bb.ui.requestInput({
      threadId: "thread-test",
      rendererId: "secret-request",
      title: "Add secrets",
      payload: { fields: ["API_KEY"] },
    });

    expect(harness.pendingInteractions).toHaveLength(1);
    harness.submitInteraction(harness.pendingInteractions[0]!.id, {
      values: { API_KEY: "sentinel" },
    });

    await expect(pending).resolves.toEqual({
      outcome: "submitted",
      value: { values: { API_KEY: "sentinel" } },
    });
    expect(harness.pendingInteractions).toEqual([]);
  });

  it("settles requests on abort and plugin disposal", async () => {
    const first = createFakePluginHost();
    const controller = new AbortController();
    const aborted = first.bb.ui.requestInput(
      {
        threadId: "thread-test",
        rendererId: "form",
        title: "Form",
        payload: null,
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(aborted).resolves.toEqual({
      outcome: "cancelled",
      reason: "request-aborted",
    });

    const second = createFakePluginHost();
    const disposed = second.bb.ui.requestInput({
      threadId: "thread-test",
      rendererId: "form",
      title: "Form",
      payload: null,
    });
    await second.harness.dispose();
    await expect(disposed).resolves.toEqual({
      outcome: "cancelled",
      reason: "plugin-disposed",
    });
  });

  it("uses the production validation and error names", () => {
    const { bb } = createFakePluginHost();
    expect(() =>
      bb.ui.requestInput({
        threadId: "",
        rendererId: "form",
        title: "Form",
        payload: null,
      }),
    ).toThrow("ui.requestInput threadId must be a non-empty string");
  });
});

describe("host control plane", () => {
  it("validates typed host calls and delivers host lifecycle events", async () => {
    const contract = defineRpcContract({
      ping: {
        input: z.object({ value: z.string() }).strict(),
        output: z.object({ pong: z.string() }).strict(),
      },
    });
    const experimental_signals = {
      changed: {
        payload: z.object({ sequence: z.number().int() }).strict(),
      },
    };
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: ({ input }) => ({
        pong: String(Reflect.get(Object(input), "value")),
      }),
    });
    const client = bb.hosts.experimental_client({
      contract,
      experimental_signals,
    });

    await expect(
      client.call("ping", { value: "hello" }, { hostId: "host-1" }),
    ).resolves.toEqual({ pong: "hello" });
    expect(harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "ping",
        input: { value: "hello" },
        hostId: "host-1",
      },
    ]);

    const events: unknown[] = [];
    client.experimental_onWorkerExit((event) => {
      events.push({ workerExit: event });
    });
    client.experimental_onSignal("changed", (event) => {
      events.push({ signal: event });
    });
    await harness.experimental_emitHostWorkerExit("host-1");
    expect(events.at(-1)).toEqual({ workerExit: { hostId: "host-1" } });
    await harness.experimental_emitHostSignal("host-1", "changed", {
      sequence: 2,
    });
    expect(events.at(-1)).toEqual({
      signal: { hostId: "host-1", payload: { sequence: 2 } },
    });
    await expect(
      harness.experimental_emitHostSignal("host-1", "changed", {
        sequence: 2.5,
      }),
    ).rejects.toThrow(/validation failed/u);
  });

  it("uses validated current-state replacements and read-only tunnel identity", async () => {
    const { bb, harness } = createFakePluginHost({
      sharedPortTunnelIdentities: {
        "host-1": { label: "sawyer-air", baseDomain: "getbb.app" },
      },
    });

    await expect(bb.hosts.ensureSharedPortTunnel("host-1")).resolves.toEqual({
      label: "sawyer-air",
      baseDomain: "getbb.app",
    });
    bb.hosts.declareSharedPorts("host-1", [8080, 3000, 8080]);
    bb.hosts.declareSharedPorts("host-2", [4173]);
    bb.hosts.declareSharedPorts("host-1", [3000]);

    expect(harness.sharedPortDeclarations).toEqual([
      { hostId: "host-1", ports: [3000] },
      { hostId: "host-2", ports: [4173] },
    ]);
    expect(() => bb.hosts.declareSharedPorts("host-3", [0])).toThrow(
      /between 1 and 65535/,
    );

    await harness.dispose();
    expect(harness.sharedPortDeclarations).toEqual([]);
  });
});

describe("storage", () => {
  it("kv round-trips JSON, lists by prefix sorted, and enforces the 256KB cap", async () => {
    const { bb } = createFakePluginHost();
    await bb.storage.kv.set("slack:b", { channel: "C1" });
    await bb.storage.kv.set("slack:a", 42);
    await bb.storage.kv.set("other", "x");
    expect(await bb.storage.kv.get("slack:b")).toEqual({ channel: "C1" });
    expect(await bb.storage.kv.list("slack:")).toEqual(["slack:a", "slack:b"]);
    expect(await bb.storage.kv.list()).toEqual(["other", "slack:a", "slack:b"]);
    await bb.storage.kv.delete("slack:a");
    expect(await bb.storage.kv.get("slack:a")).toBeUndefined();

    await expect(
      bb.storage.kv.set("big", "x".repeat(256 * 1024)),
    ).rejects.toThrow(/limit is 262144 \(256KB\)/);
  });

  it("database() returns one shared database and migrate() is append-only by index", () => {
    const { bb } = createFakePluginHost();
    const db = bb.storage.database();
    bb.storage.migrate(db, [
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
    ]);
    db.prepare("INSERT INTO notes (body) VALUES (?)").run("hello");

    const again = bb.storage.database();
    expect(again).toBe(db);
    bb.storage.migrate(again, [
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
      "ALTER TABLE notes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
    ]);
    const rows = again.prepare("SELECT body, starred FROM notes").all();
    expect(rows).toEqual([{ body: "hello", starred: 0 }]);
    expect(() =>
      bb.storage.migrate(again, [
        "CREATE TABLE replacements (id INTEGER PRIMARY KEY)",
      ]),
    ).toThrow(/migration 0 does not match the recorded statement/);
  });

  it("reserves unknown legacy migration indexes", () => {
    const { bb } = createFakePluginHost();
    const db = bb.storage.database();
    db.exec(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY); CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO _bb_migrations VALUES (0, 1), (2, 1)",
    );

    bb.storage.migrate(db, ["CREATE TABLE notes (id INTEGER PRIMARY KEY)"]);

    expect(
      db
        .prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id")
        .all(),
    ).toEqual([
      { id: 0, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 2, statement_hash: "legacy-unknown" },
    ]);
    expect(() =>
      bb.storage.migrate(db, [
        "CREATE TABLE notes (id INTEGER PRIMARY KEY)",
        "SELECT 1",
        "SELECT 2",
      ]),
    ).toThrow(/migration 2 does not match the recorded statement/);
  });

  it("database() replaces a handle the plugin closed itself, like the host", () => {
    const { bb } = createFakePluginHost();
    const db = bb.storage.database();
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    db.prepare("INSERT INTO notes (body) VALUES (?)").run("hello");
    db.close();

    const reopened = bb.storage.database();
    expect(reopened).not.toBe(db);
    expect(reopened.open).toBe(true);
    expect(reopened.prepare("SELECT body FROM notes").all()).toEqual([
      { body: "hello" },
    ]);
    expect(bb.storage.database()).toBe(reopened);
  });
});

describe("settings", () => {
  function defineSettings(bb: BbPluginApi) {
    return bb.settings.define({
      token: { type: "string", label: "Token", secret: true },
      mode: {
        type: "select",
        label: "Mode",
        options: ["fast", "slow"],
        default: "fast",
      },
      enabled: { type: "boolean", label: "Enabled", default: true },
      retries: {
        type: "number",
        label: "Retries",
        experimental_schema: z.number().int().min(0).max(5),
        default: 3,
      },
    });
  }

  it("resolves pre-seeded values, defaults, and type mismatches like the host", async () => {
    const { bb } = createFakePluginHost({
      settings: { token: "xoxb-1", enabled: false },
    });
    const handle = defineSettings(bb);
    expect(await handle.get()).toEqual({
      token: "xoxb-1",
      mode: "fast",
      enabled: false,
      retries: 3,
    });
  });

  it("setSettings validates, fires onChange with next/prev, and skips no-op updates", async () => {
    const { bb, harness } = createFakePluginHost();
    const handle = defineSettings(bb);
    const changes: Array<{ next: unknown; prev: unknown }> = [];
    handle.onChange((next, prev) => changes.push({ next, prev }));

    await expect(harness.setSettings({ nope: "x" })).rejects.toThrow(
      'unknown setting "nope"',
    );
    await expect(harness.setSettings({ mode: "warp" })).rejects.toThrow(
      "must be one of: fast, slow",
    );

    await harness.setSettings({ token: "xoxb-2", mode: "slow", retries: 5 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      next: { token: "xoxb-2", mode: "slow", enabled: true, retries: 5 },
      prev: { token: undefined, mode: "fast", enabled: true, retries: 3 },
    });

    await harness.setSettings({ mode: "slow" });
    expect(changes).toHaveLength(1);

    await harness.setSettings({ mode: null });
    expect(changes).toHaveLength(2);
    expect(await handle.get()).toMatchObject({ mode: "fast" });

    await expect(harness.setSettings({ retries: "4" })).rejects.toThrow(
      "expects a finite number",
    );
    await expect(harness.setSettings({ retries: 6 })).rejects.toThrow(
      "Too big",
    );
    await expect(harness.setSettings({ retries: Number.NaN })).rejects.toThrow(
      "expects a finite number",
    );
  });

  it("validates strings and lets plugin server code persist its own settings", async () => {
    const { bb, harness } = createFakePluginHost();
    const handle = bb.settings.define({
      notes: {
        type: "string",
        label: "Notes",
        experimental_schema: z
          .string()
          .max(4, "Notes must be at most 4 characters"),
        default: "",
      },
      payload: {
        type: "string",
        label: "Payload",
        experimental_schema: z.string().superRefine((value, context) => {
          if (value.length === 0) return;
          try {
            if (!Array.isArray(JSON.parse(value))) {
              context.addIssue({
                code: "custom",
                message: "Payload must be a JSON array",
              });
            }
          } catch {
            context.addIssue({
              code: "custom",
              message: "Payload must be valid JSON",
            });
          }
        }),
        default: "",
      },
    });
    const changes: string[] = [];
    handle.onChange((next) => changes.push(next.notes));

    await expect(handle.experimental_set({ notes: "test" })).resolves.toEqual({
      notes: "test",
      payload: "",
    });
    expect(changes).toEqual(["test"]);
    await expect(harness.setSettings({ notes: "longer" })).rejects.toThrow(
      "at most 4 characters",
    );
    await expect(harness.setSettings({ payload: "{}" })).rejects.toThrow(
      "must be a JSON array",
    );
  });

  it("rejects duplicate and invalid descriptors at define time", () => {
    const { bb } = createFakePluginHost();
    defineSettings(bb);
    expect(() =>
      bb.settings.define({ token: { type: "string", label: "Again" } }),
    ).toThrow('setting "token" is already defined');
    expect(() =>
      bb.settings.define({
        broken: { type: "select", label: "B", options: ["a"], default: "z" },
      }),
    ).toThrow('default for setting "broken" must be one of its options');
    expect(() =>
      bb.settings.define({
        pem: {
          type: "string",
          label: "Key",
          secret: true,
          experimental_multiline: true,
        },
      }),
    ).toThrow(
      'invalid descriptor for setting "pem" (experimental_multiline): a secret setting cannot be experimental_multiline',
    );
    expect(() =>
      bb.settings.define({
        notes: { type: "string", label: "Notes", experimental_multiline: true },
      }),
    ).not.toThrow();
    expect(() =>
      bb.settings.define({
        invalidRetries: {
          type: "number",
          label: "Retries",
          default: Number.POSITIVE_INFINITY,
        },
      }),
    ).toThrow('invalid descriptor for setting "invalidRetries"');
    expect(() =>
      bb.settings.define({
        payload: {
          type: "string",
          label: "Payload",
          experimental_schema: z
            .string()
            .regex(/^\{\}$/u, "Payload must be a JSON object"),
          default: "[]",
        },
      }),
    ).toThrow(
      'invalid default for setting "payload": Payload must be a JSON object',
    );
    expect(() =>
      bb.settings.define({
        normalized: {
          type: "string",
          label: "Normalized",
          experimental_schema: z.string().transform((value) => value.trim()),
          default: " padded ",
        },
      }),
    ).toThrow('schema for setting "normalized" must not transform its value');
    expect(() =>
      bb.settings.define({
        remote: {
          type: "string",
          label: "Remote",
          experimental_schema: z.string().refine(async () => true),
          default: "value",
        },
      }),
    ).toThrow(/schema for setting "remote".*synchron/u);
  });
});

describe("rpc", () => {
  it("callRpc validates and JSON-normalizes input and output", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "notes" });
    const contract = defineRpcContract({
      echo: {
        input: z.object({ when: z.string() }),
        output: z.object({ got: z.object({ when: z.string() }) }),
      },
    });
    bb.rpc.register(contract, {
      echo: (input) => ({ got: input }),
    });
    const result = await harness.callRpc("echo", {
      when: "1970-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({ got: { when: "1970-01-01T00:00:00.000Z" } });

    await expect(harness.callRpc("missing")).rejects.toThrow(
      'plugin "notes" has no rpc method "missing"',
    );
    await expect(harness.callRpc("missing")).rejects.toMatchObject({
      code: "unknown_method",
    });
  });

  it("matches production validation, handler, and serialization failures", async () => {
    const { bb, harness } = createFakePluginHost();
    let calls = 0;
    const contract = defineRpcContract({
      checked: {
        input: z.object({ value: z.string().min(1) }),
        output: z.object({ value: z.string() }),
      },
      badOutput: {
        input: z.null(),
        output: z.custom<unknown>((value) => typeof value === "string"),
      },
      throws: { input: z.null(), output: z.null() },
      cyclic: { input: z.null(), output: z.any() },
      nonFinite: { input: z.null(), output: z.any() },
    });
    bb.rpc.register(contract, {
      checked(input) {
        calls += 1;
        return input;
      },
      badOutput: () => 1,
      throws: () => {
        throw new Error("boom");
      },
      cyclic: () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
      nonFinite: () => ({ value: Number.POSITIVE_INFINITY }),
    });

    await expect(
      harness.callRpc("checked", { value: "" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
    expect(calls).toBe(0);
    await expect(harness.callRpc("badOutput")).rejects.toMatchObject({
      code: "invalid_output",
    });
    await expect(harness.callRpc("throws")).rejects.toMatchObject({
      code: "handler_error",
      message: "boom",
    });
    await expect(harness.callRpc("cyclic")).rejects.toMatchObject({
      code: "non_json_result",
    });
    await expect(harness.callRpc("nonFinite")).rejects.toMatchObject({
      code: "non_json_result",
    });
  });

  it("rejects invalid and duplicate registrations", () => {
    const { bb } = createFakePluginHost();
    const listContract = defineRpcContract({
      list: { input: z.null(), output: z.array(z.string()) },
    });
    bb.rpc.register(listContract, { list: () => [] });
    expect(() => bb.rpc.register(listContract, { list: () => [] })).toThrow(
      'rpc method "list" is already registered',
    );
    const dottedContract = defineRpcContract({
      "items.list": { input: z.null(), output: z.array(z.string()) },
    });
    expect(() =>
      bb.rpc.register(dottedContract, { "items.list": () => [] }),
    ).not.toThrow();
    const badContract = defineRpcContract({
      "bad name": { input: z.null(), output: z.array(z.string()) },
    });
    expect(() =>
      bb.rpc.register(badContract, { "bad name": () => [] }),
    ).toThrow('invalid rpc method name "bad name"');
  });
});

describe("http", () => {
  it("dispatches to the exact-match route with a real Hono context", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.http.route(
      "POST",
      "/events",
      async (context) => {
        const body = await context.req.json<{ n: number }>();
        return context.json({ doubled: body.n * 2 });
      },
      { auth: "none" },
    );
    const response = await harness.fetchHttp("POST", "/events", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 21 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ doubled: 42 });

    await expect(harness.fetchHttp("GET", "/events")).rejects.toThrow(
      "no http route GET /events is registered",
    );
  });

  it("maps a throwing handler to the host's 500 shape", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.http.route("GET", "/boom", () => {
      throw new Error("nope");
    });
    const response = await harness.fetchHttp("GET", "/boom");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "plugin route failed: nope",
    });
  });

  it("adopts a structurally valid Response from another realm like the host (#1661)", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.http.route("GET", "/foreign", () => {
      const real = new Response(JSON.stringify({ foreign: true }), {
        status: 201,
        headers: { "content-type": "application/json", "x-foreign": "yes" },
      });
      return {
        status: real.status,
        statusText: real.statusText,
        headers: real.headers,
        body: real.body,
        arrayBuffer: () => real.arrayBuffer(),
        clone: () => real.clone(),
      } as unknown as Response;
    });
    bb.http.route(
      "GET",
      "/not-a-response",
      () => ({ status: 200 }) as Response,
    );

    const foreign = await harness.fetchHttp("GET", "/foreign");
    expect(foreign.status).toBe(201);
    expect(foreign.headers.get("x-foreign")).toBe("yes");
    expect(await foreign.json()).toEqual({ foreign: true });

    const malformed = await harness.fetchHttp("GET", "/not-a-response");
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({
      ok: false,
      error: "plugin route failed: http route handler must return a Response",
    });
  });

  it("drives WebSocket lifecycle events and captures text and binary sends", async () => {
    const { bb, harness } = createFakePluginHost();
    const events: string[] = [];
    bb.http.experimental_websocket(
      "/socket",
      (context) => ({
        onOpen(socket) {
          events.push(
            `open:${context.url.searchParams.get("session")}:${context.headers.get("x-marker")}`,
          );
          socket.send("ready");
        },
        onMessage(socket, data) {
          events.push(
            typeof data === "string" ? data : `binary:${data.length}`,
          );
          socket.send(data);
        },
        onClose(_socket, event) {
          events.push(`close:${event.code}:${event.reason}`);
        },
        onError(_socket, error) {
          events.push(`error:${error.message}`);
        },
      }),
      { auth: "none" },
    );

    const session = await harness.experimental_openWebSocket(
      "/socket?session=s1",
      { headers: { "x-marker": "test" } },
    );
    expect(harness.registrations.websocketRoutes).toHaveLength(1);
    expect(session.sent).toEqual(["ready"]);
    await session.receive("hello");
    await session.receive(new Uint8Array([1, 2, 3]));
    await session.error(new Error("transport"));
    await session.close(1000, "done");

    expect(session.sent).toEqual(["ready", "hello", new Uint8Array([1, 2, 3])]);
    expect(session.closeCalls).toEqual([{ code: 1000, reason: "done" }]);
    expect(session.readyState).toBe(3);
    expect(events).toEqual([
      "open:s1:test",
      "hello",
      "binary:3",
      "error:transport",
      "close:1000:done",
    ]);
  });

  it("isolates WebSocket event failures and closes sessions on reload", async () => {
    const { bb, harness } = createFakePluginHost();
    const closed: string[] = [];
    bb.http.experimental_websocket("/socket", () => ({
      onMessage() {
        throw new Error("message boom");
      },
      onClose(_socket, event) {
        closed.push(`${event.code}:${event.reason}`);
      },
    }));
    const session = await harness.experimental_openWebSocket("/socket");

    await expect(session.receive("boom")).resolves.toBeUndefined();
    expect(harness.logEntries.at(-1)?.message).toContain("message boom");
    await harness.reload(() => {});

    expect(session.closeCalls).toContainEqual({
      code: 1012,
      reason: "Plugin reloaded or disabled",
    });
    expect(session.readyState).toBe(3);
    expect(closed).toEqual(["1012:Plugin reloaded or disabled"]);
  });

  it("rejects a throwing WebSocket factory", async () => {
    const throwing = createFakePluginHost();
    throwing.bb.http.experimental_websocket("/boom", () => {
      throw new Error("factory boom");
    });
    await expect(
      throwing.harness.experimental_openWebSocket("/boom"),
    ).rejects.toThrow("factory boom");
    expect(throwing.harness.logEntries.at(-1)?.message).toContain(
      "factory boom",
    );
  });
});

describe("cli", () => {
  it("normalizes results and maps throws like the host", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.cli.register({
      name: "docs",
      summary: "Docs tools",
      run(argv) {
        if (argv[0] === "crash") throw new Error("bad flag");
        return { exitCode: 0, stdout: `ran ${argv.join(" ")}` };
      },
    });
    expect(await harness.runCli(["search", "x"])).toEqual({
      exitCode: 0,
      stdout: "ran search x",
      stderr: "",
    });
    expect(await harness.runCli(["crash"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "bb docs failed: bad flag",
    });
  });

  it("mirrors production output-limit errors without truncating", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.cli.register({
      name: "exporter",
      summary: "Export data",
      run: () => ({
        exitCode: 0,
        stdout: "x".repeat(PLUGIN_CLI_OUTPUT_MAX_BYTES + 1),
      }),
    });

    const human = await harness.runCli([]);
    expect(human).toMatchObject({
      exitCode: 1,
      stdout: "",
      error: {
        code: "plugin_cli_output_too_large",
        maxBytes: PLUGIN_CLI_OUTPUT_MAX_BYTES,
      },
    });
    expect(human.stderr).toContain("use a file/streaming command");

    const machine = await harness.runCli(["--json"]);
    expect(machine.exitCode).toBe(1);
    expect(machine.stderr).toBe("");
    expect(JSON.parse(machine.stdout)).toEqual({ error: machine.error });
  });

  it("uses the production host's reserved CLI names", () => {
    for (const name of RESERVED_BB_CLI_COMMANDS) {
      const reservedHost = createFakePluginHost();
      expect(() =>
        reservedHost.bb.cli.register({
          name,
          summary: "nope",
          run: () => ({ exitCode: 0 }),
        }),
      ).not.toThrow();
      expect(reservedHost.harness.logEntries).toEqual([
        {
          level: "warn",
          message: `CLI command "${name}" collides with core command "bb ${name}"; core keeps the short form. Use "bb plugin run test-plugin" to invoke this plugin.`,
        },
      ]);
    }

    const availableHost = createFakePluginHost();
    expect(() =>
      availableHost.bb.cli.register({
        name: "ui",
        summary: "UI tools",
        run: () => ({ exitCode: 0 }),
      }),
    ).not.toThrow();
    expect(availableHost.harness.logEntries).toEqual([]);
  });

  it("rejects a duplicate registration like the production host", () => {
    const { bb } = createFakePluginHost();
    const registration = {
      name: "docs",
      summary: "Docs tools",
      run: () => ({ exitCode: 0 }),
    };
    bb.cli.register(registration);
    expect(() => bb.cli.register(registration)).toThrow(
      "cli command is already registered",
    );
  });
});

describe("background", () => {
  it("runService starts once, exposes the AbortController, and resolves on abort", async () => {
    const { bb, harness } = createFakePluginHost();
    let sawAbort = false;
    bb.background.service("watcher", {
      start(signal) {
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
      },
    });
    const { controller, done } = harness.runService("watcher");
    controller.abort();
    await done;
    expect(sawAbort).toBe(true);
  });

  it("treats NeedsConfigurationError (by name) as needs-configuration, not a crash", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.background.service("socket", {
      start() {
        throw Object.assign(new Error("set the token first"), {
          name: "NeedsConfigurationError",
        });
      },
    });
    await harness.runService("socket").done;
    expect(harness.needsConfigurationMessages).toEqual(["set the token first"]);
  });

  it("validates cron expressions at registration and runs schedules on demand", async () => {
    const { bb, harness } = createFakePluginHost();
    expect(() => bb.background.schedule("sync", "not-cron", () => {})).toThrow(
      'invalid cron "not-cron" for schedule "sync"',
    );

    let runs = 0;
    bb.background.schedule("sync", "*/5 * * * *", () => {
      runs += 1;
    });
    await harness.runSchedule("sync");
    expect(runs).toBe(1);
  });
});

describe("thread events", () => {
  it("emits a typed thread.active payload", async () => {
    const { bb, harness } = createFakePluginHost();
    const seen: string[] = [];
    bb.events.on("thread.active", ({ thread }) => {
      seen.push(`${thread.id}:${thread.status}`);
    });

    const { errors } = await harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "th_active", status: "active" }),
    });

    expect(seen).toEqual(["th_active:active"]);
    expect(errors).toEqual([]);
  });

  it("emitThreadEvent delivers typed payloads and captures handler errors", async () => {
    const { bb, harness } = createFakePluginHost();
    const seen: Array<string | null> = [];
    bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
      seen.push(`${thread.id}:${lastAssistantText}`);
    });
    bb.events.on("thread.idle", () => {
      throw new Error("handler exploded");
    });
    const { errors } = await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_9" }),
      lastAssistantText: "done",
    });
    expect(seen).toEqual(["th_9:done"]);
    expect(errors).toHaveLength(1);
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message: "thread.idle handler failed: handler exploded",
    });
  });

  it("rejects unknown events at registration", () => {
    const { bb } = createFakePluginHost();
    expect(() =>
      bb.events.on("thread.unknown" as "thread.idle", () => {}),
    ).toThrow('unknown event "thread.unknown"');
  });
});

describe("sdk", () => {
  it("records calls with plugin spawn attribution and runs stubs", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "slack-bot",
      sdk: {
        threads: { spawn: async () => ({ id: "th_1" }) },
      },
    });
    const thread = await bb.sdk.threads.spawn({
      projectId: "p1",
      prompt: "hi",
      environment: { type: "project-default" },
    });
    expect(thread).toEqual({ id: "th_1" });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        {
          projectId: "p1",
          prompt: "hi",
          environment: { type: "project-default" },
          origin: "plugin",
          originPluginId: "slack-bot",
        },
      ],
    ]);
  });

  it("keeps nested plugin administration available through the backend SDK", async () => {
    const catalog = { pluginCount: 1 };
    const { bb, harness } = createFakePluginHost({
      sdk: {
        plugins: {
          catalog: {
            status: async () => catalog,
          },
        },
      },
    });

    await expect(bb.sdk.plugins.catalog.status()).resolves.toEqual(catalog);
    expect(harness.sdk.callsTo("plugins.catalog.status")).toEqual([[]]);
  });

  it("throws a stub-naming error for unstubbed methods and accepts late stubs", async () => {
    const { bb, harness } = createFakePluginHost();
    expect(() => bb.sdk.projects.list({})).toThrow(
      "bb.sdk.projects.list is not stubbed",
    );
    harness.sdk.stub("projects.list", async () => []);
    await expect(bb.sdk.projects.list({})).resolves.toEqual([]);
    expect(harness.sdk.callsTo("projects.list")).toHaveLength(2);
  });
});

describe("agent tools", () => {
  const configurationContext = makePluginAgentConfigurationContext({
    provider: {
      id: "codex",
      model: "gpt-5",
      capabilities: { supportsNativeUserQuestion: false },
    },
  });

  it("validates zod parameters per call and executes with a default context", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.agents.registerTool({
      name: "lookup_doc",
      description: "Look up a doc",
      parameters: z.object({ query: z.string().min(1) }),
      execute: ({ query }, ctx) => `${query} for ${ctx.threadId}`,
    });
    expect(harness.registrations.agentTools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
    });
    await expect(
      harness.callAgentTool("lookup_doc", { query: "hi" }),
    ).resolves.toBe("hi for thread-test");
    await expect(
      harness.callAgentTool("lookup_doc", { query: 3 }),
    ).rejects.toThrow('tool "lookup_doc" arguments are invalid');
  });

  it("records a tool's presentation and hands it to the provider-facing tool set", async () => {
    const { bb, harness } = createFakePluginHost();
    const presentation = {
      label: { pending: "Looking up a doc", completed: "Looked up a doc" },
      icon: { glyph: "Book" },
      suppress: false,
      tint: { light: "#123456", dark: "#abcdef" },
    };
    bb.agents.registerTool({
      name: "lookup_doc",
      description: "Look up a doc",
      presentation,
      parameters: { type: "object" },
      execute: () => "ok",
    });
    bb.agents.registerTool({
      name: "plain_tool",
      description: "No presentation",
      parameters: { type: "object" },
      execute: () => "ok",
    });
    expect(harness.registrations.agentTools[0]?.presentation).toEqual(
      presentation,
    );
    expect(harness.registrations.agentTools[1]?.presentation).toBeNull();
    const resolved =
      await harness.resolveAgentConfiguration(configurationContext);
    expect(resolved.tools.map((tool) => tool.presentation)).toEqual([
      presentation,
      null,
    ]);
  });

  it("lets a tool presentation name one of the plugin's own declared icons and nothing else, like production", () => {
    const { bb } = createFakePluginHost({
      pluginId: "tooled",
      experimental_declaredIconNames: ["stamp"],
    });
    const tool = (name: string, glyph: string) => ({
      name,
      description: "Names an icon",
      presentation: { icon: { glyph } },
      parameters: { type: "object" },
      execute: () => "ok",
    });
    expect(() =>
      bb.agents.registerTool(tool("stamp_tool", "tooled/stamp")),
    ).not.toThrow();
    expect(() =>
      bb.agents.registerTool(tool("undeclared_tool", "tooled/seal")),
    ).toThrow(
      'tool "undeclared_tool" presentation.icon "tooled/seal" is not an icon declared by plugin "tooled"',
    );
    expect(() =>
      bb.agents.registerTool(tool("foreign_tool", "other-plugin/stamp")),
    ).toThrow(
      'tool "foreign_tool" presentation.icon "other-plugin/stamp" is not an icon declared by plugin "tooled"',
    );
    expect(() =>
      bb.agents.registerTool(tool("host_tool", "Zap")),
    ).not.toThrow();
  });

  it("rejects a presentation with the production host's exact messages", () => {
    const { bb } = createFakePluginHost();
    const register = (presentation: PluginAgentToolPresentation) =>
      bb.agents.registerTool({
        name: "lookup_doc",
        description: "Look up a doc",
        presentation,
        parameters: { type: "object" },
        execute: () => "ok",
      });
    expect(() =>
      register({
        label: {
          pending: "p".repeat(PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS + 1),
          completed: "Looked up a doc",
        },
      }),
    ).toThrow(
      `tool "lookup_doc" presentation.label strings must be non-empty and at most ${PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS} characters`,
    );
    expect(() =>
      register({ label: { pending: "Looking up a doc", completed: "  " } }),
    ).toThrow(
      `tool "lookup_doc" presentation.label strings must be non-empty and at most ${PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS} characters`,
    );
    expect(() => register({ icon: { glyph: "" } })).toThrow(
      'tool "lookup_doc" presentation.icon must be { glyph: string }',
    );
    expect(() =>
      // @ts-expect-error — a plugin compiled against its own types can still
      register({ icon: "Book" }),
    ).toThrow('tool "lookup_doc" presentation.icon must be { glyph: string }');
    expect(() =>
      // @ts-expect-error — an array is not a presentation object.
      register([]),
    ).toThrow('tool "lookup_doc" presentation must be an object');
  });

  it("records a valid presentation normalized the way the production host stores it", () => {
    const { bb, harness } = createFakePluginHost();
    const declared = {
      label: { pending: "Looking up a doc", completed: "Looked up a doc" },
      icon: { glyph: "Book" },
      extra: { markup: "<b>" },
    };
    bb.agents.registerTool({
      name: "lookup_doc",
      description: "Look up a doc",
      presentation: declared,
      parameters: { type: "object" },
      execute: () => "ok",
    });
    const recorded = harness.registrations.agentTools[0]?.presentation;
    expect(recorded).toEqual(
      parsePluginAgentToolPresentation("lookup_doc", declared),
    );
    expect(recorded).toEqual({
      label: { pending: "Looking up a doc", completed: "Looked up a doc" },
      icon: { glyph: "Book" },
    });
    expect(recorded).not.toBe(declared);
    expect(recorded?.label).not.toBe(declared.label);
  });

  it.each([
    [
      "experimental_presentation",
      'registerTool: "experimental_presentation" was renamed to "presentation" in SDK 0.4.16 (tool "stale_tool")',
    ],
    [
      "experimental_statusLabels",
      'registerTool: "experimental_statusLabels" was folded into "presentation" (labels) in SDK 0.4.16 (tool "stale_tool")',
    ],
    [
      "experimental_rowStyle",
      'registerTool: tool "stale_tool" contains unknown field: experimental_rowStyle',
    ],
  ])(
    "rejects a registration built against SDK <0.4.16 that carries %s with the production host's message",
    (field, message) => {
      const { bb, harness } = createFakePluginHost();
      expect(() =>
        bb.agents.registerTool({
          name: "stale_tool",
          description: "Built against an SDK before 0.4.16",
          [field]: { pending: "Working", completed: "Worked" },
          parameters: { type: "object" },
          execute: () => "ok",
        }),
      ).toThrow(message);
      expect(harness.registrations.agentTools).toEqual([]);
    },
  );

  it("rejects recursive schemas at registration and configuration", async () => {
    const { bb, harness } = createFakePluginHost();

    expect(() =>
      bb.agents.registerTool({
        name: "recursive_zod",
        description: "Recursive zod schema",
        parameters: z.object({ value: z.json() }),
        execute: () => "unused",
      }),
    ).toThrow(/recursive JSON Schema \$ref/);

    bb.agents.registerTool({
      name: "acyclic_ref",
      description: "Acyclic local reference",
      parameters: {
        type: "object",
        properties: { label: { $ref: "#/$defs/label" } },
        $defs: { label: { type: "string" } },
      },
      execute: () => "ok",
    });
    bb.agents.configure(() => ({
      tools: [
        {
          name: "acyclic_ref",
          parameters: {
            type: "object",
            properties: { nested: { $ref: "#" } },
          },
        },
      ],
      skills: [],
    }));

    await expect(
      harness.resolveAgentConfiguration(configurationContext),
    ).resolves.toEqual({ tools: [], skills: [], instructions: null });
    expect(harness.logEntries.at(-1)?.message).toContain(
      "recursive JSON Schema $ref",
    );
  });

  it("rejects duplicate keyed registrations like the production host", () => {
    const { bb } = createFakePluginHost();
    const tool = {
      name: "lookup_doc",
      description: "Look up a doc",
      parameters: { type: "object" },
      execute: () => "ok",
    };
    bb.agents.registerTool(tool);
    expect(() => bb.agents.registerTool(tool)).toThrow(
      'tool "lookup_doc" is already registered',
    );
    bb.agents.contributeInstructions(() => "first");
    expect(() => bb.agents.contributeInstructions(() => "second")).toThrow(
      "agent instructions are already registered",
    );
    bb.agents.configure(() => ({ tools: [], skills: [] }));
    expect(() =>
      bb.agents.configure(() => ({ tools: [], skills: [] })),
    ).toThrow("agent configuration is already registered");
  });

  it("resolves conditional tools, skills, context, and capped instructions without rebuilding registrations", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "conditional",
      agentSkillIds: ["alpha-skill", "beta-skill"],
    });
    for (const name of ["alpha_tool", "beta_tool"]) {
      bb.agents.registerTool({
        name,
        description: name,
        parameters: { type: "object" },
        execute: () => name,
      });
    }
    const contexts: PluginAgentConfigurationContext[] = [];
    bb.agents.configure((context) => {
      contexts.push(context);
      const alpha = context.host.id === "host-test";
      return {
        tools: [alpha ? "alpha_tool" : "beta_tool"],
        skills: [alpha ? "alpha-skill" : "beta-skill"],
        instructions:
          `${context.provider.id}:${context.provider.model}:`.padEnd(5000, "x"),
      };
    });

    const alpha = await harness.resolveAgentConfiguration(configurationContext);
    const betaContext = makePluginAgentConfigurationContext({
      thread: { id: "thread-beta" },
      host: { id: "host-beta", name: "Beta host" },
      provider: {
        id: "claude-code",
        model: "claude-opus",
      },
    });
    const beta = await harness.resolveAgentConfiguration(betaContext);

    expect(alpha.tools.map((tool) => tool.name)).toEqual(["alpha_tool"]);
    expect(alpha.skills).toEqual(["alpha-skill"]);
    expect(alpha.instructions).toHaveLength(4096);
    expect(beta.tools.map((tool) => tool.name)).toEqual(["beta_tool"]);
    expect(beta.skills).toEqual(["beta-skill"]);
    expect(contexts).toEqual([configurationContext, betaContext]);
    expect(harness.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "alpha_tool",
      "beta_tool",
    ]);
  });

  it("fails closed for unknown and duplicate configure ids", async () => {
    const unknown = createFakePluginHost({ agentSkillIds: ["known-skill"] });
    unknown.bb.agents.configure(() => ({
      tools: ["missing-tool"],
      skills: ["known-skill"],
    }));
    await expect(
      unknown.harness.resolveAgentConfiguration(configurationContext),
    ).resolves.toEqual({ tools: [], skills: [], instructions: null });
    expect(unknown.harness.logEntries.at(-1)?.message).toContain(
      'unknown tool id "missing-tool"',
    );

    const duplicate = createFakePluginHost({ agentSkillIds: ["known-skill"] });
    duplicate.bb.agents.configure(() => ({
      tools: [],
      skills: ["known-skill", "known-skill"],
    }));
    await duplicate.harness.resolveAgentConfiguration(configurationContext);
    expect(duplicate.harness.logEntries.at(-1)?.message).toContain(
      'duplicate id "known-skill"',
    );
  });
});

describe("dispose", () => {
  it("reloads atomically while preserving storage and the direct harness API", async () => {
    const host = createFakePluginHost({ pluginId: "reloadable" });
    const oldContract = defineRpcContract({
      version: { input: z.null(), output: z.literal("old") },
    });
    host.bb.rpc.register(oldContract, { version: () => "old" as const });
    await host.bb.storage.kv.set("cursor", { page: 2 });
    const oldDatabase = host.bb.storage.database();
    oldDatabase.exec("CREATE TABLE state (value TEXT NOT NULL)");
    oldDatabase.prepare("INSERT INTO state (value) VALUES (?)").run("kept");

    expect(host.harness.behavior.callRpc).toBe(host.harness.callRpc);
    expect(host.harness.inspection.registrations).toBe(
      host.harness.registrations,
    );
    expect(host.harness.lifecycle.dispose).toBe(host.harness.dispose);

    await expect(
      host.harness.lifecycle.reload((bb) => {
        bb.rpc.register(oldContract, { version: () => "old" as const });
        bb.rpc.register(oldContract, { version: () => "old" as const });
      }),
    ).rejects.toThrow('rpc method "version" is already registered');

    await expect(host.harness.callRpc("version")).resolves.toBe("old");
    await expect(host.bb.storage.kv.get("cursor")).resolves.toEqual({
      page: 2,
    });

    const nextContract = defineRpcContract({
      version: { input: z.null(), output: z.literal("new") },
    });
    const replacement = await host.harness.lifecycle.reload(async (bb) => {
      await expect(bb.storage.kv.get("cursor")).resolves.toEqual({ page: 2 });
      expect(
        bb.storage.database().prepare("SELECT value FROM state").get(),
      ).toEqual({ value: "kept" });
      bb.rpc.register(nextContract, { version: () => "new" as const });
    });

    await expect(replacement.harness.callRpc("version")).resolves.toBe("new");
    await expect(host.bb.storage.kv.get("cursor")).rejects.toThrow(
      "used a stale API handle",
    );
    expect(oldDatabase.open).toBe(false);
    await replacement.harness.dispose();
  });

  it("aborts services, runs hooks LIFO, closes the database, and poisons the handle", async () => {
    const { bb, harness } = createFakePluginHost();
    const order: string[] = [];
    bb.onDispose(() => {
      order.push("first");
    });
    bb.onDispose(() => {
      order.push("second");
      throw new Error("hook exploded");
    });
    bb.background.service("svc", {
      start(signal) {
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            order.push("aborted");
            resolve();
          });
        });
      },
    });
    const db = bb.storage.database();
    const { done } = harness.runService("svc");

    await harness.dispose();
    await done;
    expect(order).toEqual(["aborted", "second", "first"]);
    expect(db.open).toBe(false);
    await expect(bb.storage.kv.get("x")).rejects.toThrow(
      "used a stale API handle",
    );
    expect(() => bb.sdk).toThrow("stale");
    await harness.dispose();
  });
});

describe("realtime and status", () => {
  it("normalizes published payloads and records needs-configuration", () => {
    const { bb, harness } = createFakePluginHost();
    bb.realtime.publish("notes-changed", undefined);
    bb.realtime.publish("notes-changed", { at: new Date(0) });
    expect(harness.realtimeSignals).toEqual([
      { channel: "notes-changed", payload: null },
      {
        channel: "notes-changed",
        payload: { at: "1970-01-01T00:00:00.000Z" },
      },
    ]);
    expect(() => bb.realtime.publish("bad", { boom: 1n })).toThrow(
      "not JSON-serializable",
    );

    bb.status.needsConfiguration("");
    bb.status.needsConfiguration("set a token");
    expect(harness.needsConfigurationMessages).toEqual([
      "needs configuration",
      "set a token",
    ]);
  });
});

describe("providers.register", () => {
  function agentDeclaration(
    overrides: Record<string, unknown> = {},
  ): Parameters<BbPluginApi["providers"]["register"]>[0] {
    return {
      id: "my-agent",
      displayName: "My Agent",
      icon: "./icons/agent.svg",
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: true,
        fork: "tip",
        supportsManualCompaction: true,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["accept-edits", "full"],
        reasoningLevels: ["low", "medium", "high"],
      },
      composerActions: ["plan"],
      ...overrides,
    } as Parameters<BbPluginApi["providers"]["register"]>[0];
  }

  it("rejects malformed declarations with the shared host policy", () => {
    const { bb } = createFakePluginHost();
    const register = bb.providers.register;

    expect(() => register(agentDeclaration({ id: "Bad_Id!" }))).toThrow(
      /invalid provider id/,
    );
    expect(() => register(agentDeclaration({ id: "x" }))).toThrow(
      /invalid provider id/,
    );
    expect(() => register(agentDeclaration({ displayName: "   " }))).toThrow(
      /displayName must be 1-80 non-blank characters/,
    );
    expect(() =>
      register(
        agentDeclaration({
          capabilities: {
            ...agentDeclaration().capabilities,
            permissionModes: [],
          },
        }),
      ),
    ).toThrow(/permissionModes must include at least one entry/);
    expect(() =>
      register(
        agentDeclaration({
          capabilities: {
            ...agentDeclaration().capabilities,
            reasoningLevels: ["low", "low"],
          },
        }),
      ),
    ).toThrow(/reasoningLevels entry "low" is duplicated/);
    expect(() =>
      register(
        agentDeclaration({
          capabilities: { ...agentDeclaration().capabilities, fork: true },
        }),
      ),
    ).toThrow(/capabilities.fork must be one of none, tip, checkpoint/);
    expect(() =>
      register(
        agentDeclaration({
          maintenance: {
            usage: "yes" as unknown as boolean,
            installation: false,
          },
        }),
      ),
    ).toThrow(/maintenance.usage must be a boolean/);
    expect(() =>
      register(agentDeclaration({ icon: "./../outside.svg" })),
    ).toThrow(/icon must not escape the plugin directory/);
    expect(() => register(agentDeclaration({ icon: "/abs/icon.svg" }))).toThrow(
      /icon looks like a path but does not start with "\.\/"/,
    );
    expect(() =>
      register(agentDeclaration({ composerActions: ["plan", "plan"] })),
    ).toThrow(/composerActions entry "plan" is duplicated/);
    expect(() =>
      register(agentDeclaration({ experimental_visibility: "sometimes" })),
    ).toThrow(/experimental_visibility must be "always" or "installed"/);
    expect(() =>
      register(
        agentDeclaration({
          experimental_visibility: "installed",
          maintenance: { health: false },
        }),
      ),
    ).toThrow(/"installed" requires maintenance.health/);
    expect(() =>
      register(
        agentDeclaration({
          experimental_bridgeOptions: { timeout: Number.POSITIVE_INFINITY },
        }),
      ),
    ).toThrow(/experimental_bridgeOptions\.timeout must be finite JSON/);
    expect(() => register(agentDeclaration({ icon: "Zap" }))).not.toThrow();
  });

  it("refuses a provider icon naming an undeclared or foreign icon, like production", () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tooled",
      experimental_declaredIconNames: ["stamp"],
    });
    expect(() =>
      bb.providers.register(agentDeclaration({ icon: "tooled/seal" })),
    ).toThrow(
      'provider "my-agent" icon "tooled/seal" is not an icon declared by plugin "tooled"',
    );
    expect(() =>
      bb.providers.register(agentDeclaration({ icon: "other-plugin/stamp" })),
    ).toThrow(
      'provider "my-agent" icon "other-plugin/stamp" is not an icon declared by plugin "tooled"',
    );
    expect(harness.registrations.providerRegistrations).toEqual([]);
    bb.providers.register(agentDeclaration({ icon: "tooled/stamp" }));
    expect(harness.registrations.providerRegistrations[0]?.icon).toBe(
      "tooled/stamp",
    );
  });

  it("refuses a plugin that declares no bb.host entry, like production", () => {
    const { bb, harness } = createFakePluginHost({
      experimental_hostEntry: false,
    });
    expect(() => bb.providers.register(agentDeclaration())).toThrow(
      'provider "my-agent" has no bridge to run on: this plugin declares no "bb.host" entry in its manifest',
    );
    expect(harness.registrations.providerRegistrations).toEqual([]);
  });

  it("round-trips a registration through the harness and dispose", () => {
    const { bb, harness } = createFakePluginHost();
    const handle = bb.providers.register(
      agentDeclaration({ displayName: "  My Agent  " }),
    );

    expect(harness.registrations.providerRegistrations).toHaveLength(1);
    const registered = harness.registrations.providerRegistrations[0]!;
    expect(registered.displayName).toBe("My Agent");
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.capabilities)).toBe(true);
    expect(registered.experimental_visibility).toBe("always");

    expect(() => bb.providers.register(agentDeclaration())).toThrow(
      /already registered/,
    );

    handle.dispose();
    handle.dispose();
    expect(harness.registrations.providerRegistrations).toEqual([]);

    bb.providers.register(
      agentDeclaration({ displayName: "Second Declaration" }),
    );
    expect(
      harness.registrations.providerRegistrations.map(
        (declaration) => declaration.displayName,
      ),
    ).toEqual(["Second Declaration"]);
  });

  it("normalizes and deeply freezes opaque provider bridge options", () => {
    const { bb, harness } = createFakePluginHost();
    bb.providers.register(
      agentDeclaration({
        experimental_visibility: "installed",
        experimental_bridgeOptions: {
          launch: { command: "example-agent", args: ["serve"] },
        },
      }),
    );

    const registered = harness.registrations.providerRegistrations[0]!;
    expect(registered.experimental_visibility).toBe("installed");
    expect(registered.experimental_bridgeOptions).toEqual({
      launch: { command: "example-agent", args: ["serve"] },
    });
    expect(Object.isFrozen(registered.experimental_bridgeOptions)).toBe(true);
    expect(Object.isFrozen(registered.experimental_bridgeOptions?.launch)).toBe(
      true,
    );
  });

  it("defaults maintenance support a plugin does not declare to false", () => {
    const { bb, harness } = createFakePluginHost();
    const declaration = agentDeclaration();
    Reflect.deleteProperty(declaration, "maintenance");

    bb.providers.register(declaration);

    expect(harness.registrations.providerRegistrations[0]?.maintenance).toEqual(
      { health: false, usage: false, installation: false },
    );
  });

  it("clears registrations on dispose", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.providers.register(agentDeclaration({ id: "my-second-agent" }));
    expect(
      harness.registrations.providerRegistrations.map((entry) => entry.id),
    ).toEqual(["my-second-agent"]);

    await harness.dispose();
    expect(harness.registrations.providerRegistrations).toEqual([]);
    expect(() => bb.providers.register(agentDeclaration())).toThrow(
      "used a stale API handle",
    );
  });
});

describe("providers.experimental_contributeEnv", () => {
  it("round trips validated entries with the provider context", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "auth-proxy" });
    const contexts: unknown[] = [];
    bb.providers.experimental_contributeEnv("claude-code", (context) => {
      contexts.push(context);
      return [
        {
          name: "PLUGIN_API_URL",
          value: { serverPath: "/plugins/auth-proxy/api" },
          reason: "Route provider traffic through the plugin",
          secret: true,
        },
      ];
    });

    await expect(
      harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-1",
        projectId: "project-1",
        hostId: "host-1",
      }),
    ).resolves.toEqual([
      {
        name: "PLUGIN_API_URL",
        value: { serverPath: "/plugins/auth-proxy/api" },
        reason: "Route provider traffic through the plugin",
        secret: true,
      },
    ]);
    expect(contexts).toEqual([
      {
        threadId: "thread-1",
        projectId: "project-1",
        hostId: "host-1",
      },
    ]);
  });

  it("resolves environment-backed provider health only beside an env resolver", async () => {
    const first = createFakePluginHost();
    first.bb.providers.experimental_contributeEnvHealth("claude-code", () => ({
      label: "Proxied",
      statusMessage: "Credentials are provided by a proxy.",
    }));
    await expect(
      first.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();

    const second = createFakePluginHost();
    second.bb.providers.experimental_contributeEnv("claude-code", () => []);
    second.bb.providers.experimental_contributeEnvHealth(
      "claude-code",
      ({ hostId }) =>
        hostId === "host-one"
          ? {
              label: "Proxied",
              statusMessage: "Credentials are provided by a proxy.",
            }
          : null,
    );
    await expect(
      second.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by a proxy.",
    });
  });

  it("fails a malformed resolver closed and rejects duplicate registration", async () => {
    const { bb, harness } = createFakePluginHost();
    bb.providers.experimental_contributeEnv("codex", () => [
      {
        name: "lowercase",
        value: "hidden",
        reason: "invalid name",
        secret: false,
      },
    ]);
    expect(() =>
      bb.providers.experimental_contributeEnv("codex", () => []),
    ).toThrow("already registered");

    await expect(
      harness.behavior.resolveProviderEnv("codex", {
        threadId: "thread-1",
        projectId: "project-1",
        hostId: "host-1",
      }),
    ).resolves.toEqual([]);
    expect(harness.inspection.logEntries.at(-1)).toMatchObject({
      level: "warn",
    });
    expect(JSON.stringify(harness.inspection.logEntries)).not.toContain(
      "hidden",
    );
  });
});

describe("experimental_aiServices.register", () => {
  const declaration = {
    id: "acme-ai",
    displayName: "Acme AI",
    kinds: ["inference" as const],
  };

  it("refuses the ids the server serves directly, like production", () => {
    const { bb } = createFakePluginHost();
    for (const id of ["openai", "anthropic"]) {
      expect(() =>
        bb.experimental_aiServices.register({ ...declaration, id }),
      ).toThrow(/is reserved: the server serves it directly/u);
    }
    expect(() =>
      bb.experimental_aiServices.register(declaration),
    ).not.toThrow();
  });

  it("refuses a plugin that declares no bb.host entry, like production", () => {
    const { bb } = createFakePluginHost({ experimental_hostEntry: false });
    expect(() => bb.experimental_aiServices.register(declaration)).toThrow(
      /needs a bb\.host entry to run on: this plugin declares none/u,
    );
  });
});
