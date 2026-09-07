import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  getThread,
  migrate,
  type DbConnection,
} from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginServiceDeps,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import type { BbPluginApi } from "../../../src/services/plugins/plugin-api.js";
import {
  seedHostSession,
  seedEnvironment,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { PluginHostArtifactRegistry } from "../../../src/services/plugins/plugin-host-artifact-registry.js";
import { startTestServer, testLogger } from "../../helpers/test-app.js";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string; hostSource?: string },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "SDK fixture",
        description: "Plugin SDK fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.hostSource === undefined ? {} : { host: "./host.ts" }),
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  if (options.hostSource !== undefined) {
    await writeFile(join(rootDir, "host.ts"), options.hostSource);
  }
  return rootDir;
}

function requireApi(service: PluginService, pluginId: string): BbPluginApi {
  const api = service.getApi(pluginId);
  if (!api) throw new Error(`plugin ${pluginId} is not running`);
  return api;
}

describe("plugin bb.sdk bind gate", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;
  let pluginHostArtifacts: PluginHostArtifactRegistry;
  let appUrl: string | null;
  const sharedPorts = {
    declareSharedPorts: vi.fn(),
    validateSharedPortDeclaration: vi.fn(
      (_hostId: string, ports: readonly number[]) => [...ports],
    ),
    replaceDeclarationsForOwner: vi.fn(),
    clearDeclarationsForOwner: vi.fn(),
  };
  const ensureSharedPortTunnel = vi.fn().mockResolvedValue({
    label: "sawyer-air",
    baseDomain: "getbb.app",
  });
  const callPluginHost = vi.fn(
    async (
      _args: Parameters<NonNullable<PluginServiceDeps["callPluginHost"]>>[0],
    ) => ({ pong: true }),
  );
  const disposePluginHost = vi.fn(async () => undefined);
  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-sdk-test-"));
    sharedPorts.declareSharedPorts.mockClear();
    sharedPorts.validateSharedPortDeclaration.mockClear();
    sharedPorts.replaceDeclarationsForOwner.mockClear();
    sharedPorts.clearDeclarationsForOwner.mockClear();
    ensureSharedPortTunnel.mockClear();
    callPluginHost.mockClear();
    disposePluginHost.mockClear();
    appUrl = "https://bb.example.test";
    pluginHostArtifacts = new PluginHostArtifactRegistry();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      pluginHostArtifacts,
      sharedPorts,
      ensureSharedPortTunnel,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      getAppUrl: () => appUrl,
      loadTimeoutMs: 2000,
      callPluginHost,
      disposePluginHost,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("throws a descriptive error before bindSdk and resolves after", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-gate",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "gate");

    expect(() => api.sdk).toThrow(
      /bb\.sdk is not available until the server is listening/,
    );

    service.bindSdk({ baseUrl: "http://127.0.0.1:9" });
    expect(typeof api.sdk.threads.fork).toBe("function");
    expect(typeof api.sdk.threads.spawn).toBe("function");
  });

  it("serves the current public app URL without the SDK bind gate", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-app-url",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "app-url");

    expect(api.server.experimental_appUrl).toBe("https://bb.example.test");
    appUrl = null;
    expect(api.server.experimental_appUrl).toBeNull();
  });

  it("marks a plugin error when its factory touches bb.sdk at load time", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-eager",
      serverSource: `
        export default function plugin(bb: any) {
          bb.sdk.threads.spawn({});
        }
      `,
    });
    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain(
      "bb.sdk is not available until the server is listening",
    );
  });

  it("delivers shared-port declarations through the server control plane", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-shares",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "shares");

    await expect(api.hosts.ensureSharedPortTunnel("host-1")).resolves.toEqual({
      label: "sawyer-air",
      baseDomain: "getbb.app",
    });
    api.hosts.declareSharedPorts("host-1", [8080, 3000]);

    expect(ensureSharedPortTunnel).toHaveBeenCalledWith("host-1");

    expect(sharedPorts.declareSharedPorts).toHaveBeenCalledWith({
      ownerId: "shares",
      hostId: "host-1",
      ports: [8080, 3000],
    });

    await service.stop();
    expect(sharedPorts.clearDeclarationsForOwner).toHaveBeenCalledWith(
      "shares",
    );
  });

  it("binds typed host calls and ignores worker exits from stale generations", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-host-client",
      serverSource: `export default function plugin() {}`,
      hostSource: `
        const schema = { "~standard": { validate(value) { return { value }; } } };
        export default {
          experimental_apiVersion: 1,
          contract: { ping: { input: schema, output: schema } },
          experimental_signals: { changed: { payload: schema } },
          handlers: { ping: (input) => input },
        };
      `,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "host-client");
    const contract = defineRpcContract({
      ping: {
        input: z.object({ value: z.string() }).strict(),
        output: z.object({ pong: z.boolean() }).strict(),
      },
    });
    const experimental_signals = {
      changed: {
        payload: z.object({ sequence: z.number().int() }).strict(),
      },
    };
    const client = api.hosts.experimental_client({
      contract,
      experimental_signals,
    });

    await expect(
      client.call("ping", { value: "hello" }, { hostId: "host-1" }),
    ).resolves.toEqual({ pong: true });
    expect(callPluginHost).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "host-client",
        method: "ping",
        input: { value: "hello" },
        hostId: "host-1",
        artifact: expect.objectContaining({
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          byteLength: expect.any(Number),
          generation: expect.any(String),
        }),
      }),
    );

    const workerExitHandler = vi.fn();
    const signalHandler = vi.fn();
    client.experimental_onWorkerExit(workerExitHandler);
    client.experimental_onSignal("changed", signalHandler);
    const artifact = callPluginHost.mock.calls[0]?.[0].artifact;
    if (artifact === undefined) throw new Error("missing host artifact call");
    const servedArtifact = pluginHostArtifacts.get("host-client");
    if (servedArtifact === undefined)
      throw new Error("missing served artifact");
    expect(servedArtifact.digest).toBe(artifact.digest);
    expect(servedArtifact.byteLength).toBe(artifact.byteLength);
    expect(
      createHash("sha256")
        .update(await readFile(servedArtifact.path))
        .digest("hex"),
    ).toBe(artifact.digest);
    service.handleHostWorkerExit({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: "stale-generation",
    });
    service.handleHostSignal({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: "stale-generation",
      signal: "changed",
      payload: { sequence: 1 },
    });
    service.handleHostSignal({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: artifact.generation,
      signal: "changed",
      payload: { sequence: 2 },
    });
    service.handleHostWorkerExit({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: artifact.generation,
    });
    await vi.waitFor(() => expect(workerExitHandler).toHaveBeenCalledOnce());
    expect(workerExitHandler).toHaveBeenCalledWith({ hostId: "host-1" });
    await vi.waitFor(() => expect(signalHandler).toHaveBeenCalledOnce());
    expect(signalHandler).toHaveBeenCalledWith({
      hostId: "host-1",
      payload: { sequence: 2 },
    });
    expect(service.listHostArtifactGenerations()).toEqual([
      { pluginId: "host-client", generation: artifact.generation },
    ]);
  });

  it("rejects host calls during candidate factory registration", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-eager-host-client",
      serverSource: `
        import { defineRpcContract } from "@get-bb/plugin-sdk";
        const schema = { "~standard": { validate(value: unknown) { return { value }; } } };
        const contract = defineRpcContract({ ping: { input: schema, output: schema } });
        export default async function plugin(bb: any) {
          await bb.hosts.experimental_client({ contract }).call(
            "ping",
            {},
            { hostId: "host-1" },
          );
        }
      `,
      hostSource: `
        const schema = { "~standard": { validate(value) { return { value }; } } };
        export default {
          experimental_apiVersion: 1,
          contract: { ping: { input: schema, output: schema } },
          handlers: { ping: (input) => input },
        };
      `,
    });

    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain(
      "host plugin calls are unavailable during factory registration",
    );
    expect(callPluginHost).not.toHaveBeenCalled();
  });

  it("does not publish candidate host declarations when reload fails", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-atomic-shares",
      serverSource: `
        export default function plugin(bb: any) {
          bb.hosts.declareSharedPorts("host-1", [3000]);
        }
      `,
    });
    await service.installPath(rootDir);
    const previousApi = requireApi(service, "atomic-shares");
    expect(sharedPorts.replaceDeclarationsForOwner).toHaveBeenCalledWith(
      "atomic-shares",
      [{ hostId: "host-1", ports: [3000] }],
    );
    sharedPorts.replaceDeclarationsForOwner.mockClear();

    await writeFile(
      join(rootDir, "server.ts"),
      `
        export default function plugin(bb: any) {
          bb.hosts.declareSharedPorts("host-1", [4000]);
          throw new Error("candidate failed");
        }
      `,
    );
    await service.reload("atomic-shares");

    expect(service.getApi("atomic-shares")).toBe(previousApi);
    expect(sharedPorts.replaceDeclarationsForOwner).not.toHaveBeenCalled();
  });
});

describe("plugin bb.sdk against a running server", () => {
  it("returns the server-side Standard Schema output after the host JSON wire", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-host-transform-"));
    try {
      const { host } = seedHostSession(server.deps, {
        id: "host-plugin-transform",
      });
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-host-transform",
        serverSource: `export default function plugin() {}`,
        hostSource: `
          const schema = { "~standard": { validate(value) { return { value }; } } };
          export default {
            experimental_apiVersion: 1,
            contract: { parseDate: { input: schema, output: schema } },
            handlers: { parseDate: (input) => input },
          };
        `,
      });
      await server.pluginService.installPath(rootDir);
      const inputDate = z.string().transform((value) => new Date(value));
      const outputDate = z.string().transform((value) => new Date(value));
      const contract = defineRpcContract({
        parseDate: {
          input: z.object({ when: inputDate }).strict(),
          output: outputDate,
        },
      });
      const client = requireApi(
        server.pluginService,
        "host-transform",
      ).hosts.experimental_client({ contract });
      const iso = "2026-08-16T12:34:56.000Z";

      const resultPromise = client.call(
        "parseDate",
        { when: iso },
        { hostId: host.id },
      );
      const command = await waitForQueuedCommand(
        server,
        ({ command }) =>
          command.type === "plugin.host.call" &&
          command.pluginId === "host-transform" &&
          command.method === "parseDate",
      );
      expect(command.command).toMatchObject({
        input: { when: iso },
        timeoutMs: 30_000,
      });
      expect(command.command).not.toHaveProperty("deadlineUnixMs");
      await reportQueuedCommandSuccess(server, command, { output: iso });

      await expect(resultPromise).resolves.toEqual(new Date(iso));
    } finally {
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("keeps hidden plugin threads attributed and directly operable by id", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-sdk-live-"));
    try {
      const { host } = seedHostSession(server.deps);
      seedPrimaryHost(server.deps, host.id);
      const { project } = seedProjectWithSource(server.deps, {
        hostId: host.id,
        path: "/tmp/plugin-sdk-live-source",
      });
      const environment = seedEnvironment(server.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/plugin-sdk-live-source",
      });

      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-spawner",
        serverSource: `export default function plugin() {}`,
      });
      const entry = await server.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      const api = requireApi(server.pluginService, "spawner");

      const projects = await api.sdk.projects.list();
      expect(projects.map((p) => p.id)).toContain(project.id);
      expect(projects.map((p) => p.id)).not.toContain(PERSONAL_PROJECT_ID);
      const projectsWithoutPersonal = await api.sdk.projects.list({
        includePersonal: false,
      });
      expect(projectsWithoutPersonal.map((p) => p.id)).toEqual([project.id]);

      const projectsWithPersonal = await api.sdk.projects.list({
        includePersonal: true,
      });
      expect(projectsWithPersonal.map((p) => p.id)).toEqual([
        PERSONAL_PROJECT_ID,
        project.id,
      ]);
      const projectsWithThreadsAndPersonal = await api.sdk.projects.list({
        include: "threads",
        includePersonal: true,
      });
      expect(projectsWithThreadsAndPersonal.map((p) => p.id)).toEqual([
        PERSONAL_PROJECT_ID,
        project.id,
      ]);
      expect(projectsWithThreadsAndPersonal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: PERSONAL_PROJECT_ID, threads: [] }),
          expect.objectContaining({ id: project.id, threads: [] }),
        ]),
      );

      const thread = await api.sdk.threads.spawn({
        projectId: project.id,
        prompt: "spawned from a plugin",
        environment: { type: "project-default" },
        visibility: "hidden",
      });
      expect(thread.originPluginId).toBe("spawner");
      expect(thread.visibility).toBe("hidden");
      expect(getThread(server.db, thread.id)).toMatchObject({
        originPluginId: "spawner",
        visibility: "hidden",
      });
      await expect(
        api.sdk.threads.get({ threadId: thread.id }),
      ).resolves.toMatchObject({ id: thread.id, visibility: "hidden" });
      await expect(
        api.sdk.threads.wait({
          threadId: thread.id,
          status: "starting",
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ matched: true, threadId: thread.id });
      await expect(
        api.sdk.threads.list({ projectId: project.id }),
      ).resolves.not.toContainEqual(expect.objectContaining({ id: thread.id }));
      await expect(
        api.sdk.threads.list({ projectId: project.id, includeHidden: true }),
      ).resolves.toContainEqual(expect.objectContaining({ id: thread.id }));

      const operable = seedThread(server.deps, {
        environmentId: environment.id,
        originPluginId: "spawner",
        projectId: project.id,
        status: "idle",
        visibility: "hidden",
      });
      seedThreadRuntimeState(server.deps, {
        environmentId: environment.id,
        inputText: "Initial turn",
        providerThreadId: "provider-hidden-plugin-thread",
        threadId: operable.id,
      });
      const fork = await api.sdk.threads.fork({
        sourceThreadId: operable.id,
      });
      expect(fork).toMatchObject({
        originKind: "fork",
        originPluginId: "spawner",
        sourceThreadId: operable.id,
      });
      await expect(
        api.sdk.threads.wait({
          threadId: operable.id,
          status: "idle",
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ matched: true });
      await expect(
        api.sdk.threads.send({
          threadId: operable.id,
          mode: "auto",
          input: [{ type: "text", text: "Continue", mentions: [] }],
        }),
      ).resolves.toEqual({ ok: true, delivery: "sent" });
      const stopPromise = api.sdk.threads.stop({ threadId: operable.id });
      const stop = await waitForQueuedCommand(
        server,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === operable.id,
      );
      await reportQueuedCommandSuccess(server, stop, {
        providerCheckpointId: null,
      });
      await expect(stopPromise).resolves.toEqual({ ok: true });
    } finally {
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });
});
