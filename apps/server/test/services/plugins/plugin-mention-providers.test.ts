import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import { type PromptInput } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { sendQueuedMessage } from "../../../src/services/threads/queued-messages.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  testLogger,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const BASE = "http://127.0.0.1:3334";
const EVIL_ORIGIN = "https://evil.example";

const logger = testLogger as unknown as Logger;

const MENTION_SOURCE = `
  let resolveCalls = 0;
  export default function plugin(bb: any) {
    bb.ui.registerMentionProvider({
      id: "issues",
      label: "Linear issues",
      triggers: ["@", "#"],
      async search(ctx: any) {
        if (ctx.query === "none") return [];
        return [
          {
            id: "ISS-42",
            title: "Fix login bug",
            subtitle: "ctx:" + ctx.trigger + ":" + ctx.query + ":" + ctx.projectId + ":" + ctx.threadId,
          },
          { id: "ISS-43", title: "Ship mention providers" },
        ];
      },
      async resolve(itemId: string) {
        resolveCalls += 1;
        return {
          context: "Issue " + itemId + " details (resolve call " + resolveCalls + ")",
        };
      },
    });
    bb.ui.registerMentionProvider({
      id: "docs",
      label: "Docs",
      async search() {
        return [{ id: "onboarding", title: "Onboarding guide" }];
      },
      async resolve() {
        throw new Error("docs resolve boom");
      },
    });
    bb.ui.registerMentionProvider({
      id: "broken",
      label: "Broken",
      async search() {
        throw new Error("search boom");
      },
      async resolve() {
        return { context: 42 };
      },
    });
  }
`;

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Mention provider fixture",
        description: "Mention provider plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

function pluginMentionInput(args: {
  text: string;
  mentions: Array<{ label: string; itemId: string; pluginId?: string }>;
}): PromptInput[] {
  return [
    {
      type: "text",
      text: args.text,
      mentions: args.mentions.map((mention, index) => ({
        start: index * 2,
        end: index * 2 + 1,
        resource: {
          kind: "plugin" as const,
          pluginId: mention.pluginId ?? "mentions",
          itemId: mention.itemId,
          label: mention.label,
        },
      })),
    },
  ];
}

function seedColdIdleThreadFixture(harness: TestAppHarness, value: number) {
  const { host } = seedHostSession(harness.deps, {
    id: `host-mentions-${value}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/mentions-${value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/mentions-${value}`,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return { environment, thread };
}

function seedWarmIdleThreadFixture(harness: TestAppHarness, value: number) {
  const { environment, thread } = seedColdIdleThreadFixture(harness, value);
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-mentions-${value}`,
    threadId: thread.id,
  });
  return { environment, thread };
}

describe("plugin mention providers (bb.ui.registerMentionProvider)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    const rootDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      { name: "bb-plugin-mentions", serverSource: MENTION_SOURCE },
    );
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("lists mention providers in GET /plugins/contributions", async () => {
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/contributions`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mentionProviders: unknown };
    expect(body.mentionProviders).toEqual([
      {
        pluginId: "mentions",
        id: "issues",
        label: "Linear issues",
        triggers: ["@", "#"],
      },
      { pluginId: "mentions", id: "docs", label: "Docs", triggers: ["@"] },
      {
        pluginId: "mentions",
        id: "broken",
        label: "Broken",
        triggers: ["@"],
      },
    ]);
  });

  it("aggregates search across providers, namespaces item ids, and drops throwing providers", async () => {
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=fix&projectId=proj_1&threadId=thr_1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; groups: unknown };
    expect(body.ok).toBe(true);
    expect(body.groups).toEqual([
      {
        pluginId: "mentions",
        providerId: "issues",
        label: "Linear issues",
        items: [
          {
            itemId: "issues:ISS-42",
            title: "Fix login bug",
            subtitle: "ctx:@:fix:proj_1:thr_1",
            icon: null,
          },
          {
            itemId: "issues:ISS-43",
            title: "Ship mention providers",
            subtitle: null,
            icon: null,
          },
        ],
      },
      {
        pluginId: "mentions",
        providerId: "docs",
        label: "Docs",
        items: [
          {
            itemId: "docs:onboarding",
            title: "Onboarding guide",
            subtitle: null,
            icon: null,
          },
        ],
      },
    ]);
    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "mentions");
    expect(entry?.handlerStats.errorCount).toBe(1);
  });

  it("searches only providers registered for the requested trigger", async () => {
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=fix&trigger=%23&projectId=proj_1&threadId=thr_1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; groups: unknown };
    expect(body.ok).toBe(true);
    expect(body.groups).toEqual([
      {
        pluginId: "mentions",
        providerId: "issues",
        label: "Linear issues",
        items: [
          {
            itemId: "issues:ISS-42",
            title: "Fix login bug",
            subtitle: "ctx:#:fix:proj_1:thr_1",
            icon: null,
          },
          {
            itemId: "issues:ISS-43",
            title: "Ship mention providers",
            subtitle: null,
            icon: null,
          },
        ],
      },
    ]);
  });

  it("rejects invalid search trigger params", async () => {
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=fix&trigger=%3F`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid plugin mention trigger "?"',
    });
  });

  it("passes null project/thread context and returns empty groups for an empty query", async () => {
    const contextual = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=login`,
    );
    const body = (await contextual.json()) as {
      groups: Array<{
        providerId: string;
        items: Array<{ subtitle: string | null }>;
      }>;
    };
    expect(
      body.groups.find((group) => group.providerId === "issues")?.items[0]
        ?.subtitle,
    ).toBe("ctx:@:login:null:null");

    const empty = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=%20%20`,
    );
    expect(await empty.json()).toEqual({ ok: true, groups: [] });

    const none = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=none`,
    );
    const noneBody = (await none.json()) as {
      groups: Array<{ providerId: string }>;
    };
    expect(noneBody.groups.some((group) => group.providerId === "issues")).toBe(
      false,
    );
  });

  it("enforces local auth on search", async () => {
    const foreign = await harness.app.request(
      `${BASE}/api/v1/plugins/mentions/search?q=fix`,
      { headers: { origin: EVIL_ORIGIN } },
    );
    expect(foreign.status).toBe(403);
  });

  it("resolves each unique mention once at send and attaches agent-only context inputs", async () => {
    const { environment, thread } = seedColdIdleThreadFixture(harness, 1);

    await sendThreadMessage(harness.deps, {
      environment,
      payload: {
        input: pluginMentionInput({
          text: "@Fix login bug then @Fix login bug then @Ship mention providers",
          mentions: [
            { label: "Fix login bug", itemId: "issues:ISS-42" },
            { label: "Fix login bug", itemId: "issues:ISS-42" },
            { label: "Ship mention providers", itemId: "issues:ISS-43" },
          ],
        }),
        mode: "start",
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      },
      thread,
      trigger: "user",
    });

    const queued = await waitForQueuedCommand(
      harness,
      (candidate) =>
        candidate.command.type === "thread.start" &&
        candidate.command.threadId === thread.id,
    );
    if (queued.command.type !== "thread.start") {
      throw new Error("Expected a thread.start command");
    }
    const agentOnly = queued.command.input.filter(
      (item) => item.type === "text" && item.visibility === "agent-only",
    );
    expect(agentOnly).toHaveLength(2);
    expect(agentOnly[0]).toMatchObject({
      type: "text",
      visibility: "agent-only",
      text: expect.stringContaining("Issue ISS-42 details (resolve call 1)"),
    });
    expect(agentOnly[0]).toMatchObject({
      text: expect.stringContaining('resolved by plugin "mentions"'),
    });
    expect(agentOnly[1]).toMatchObject({
      type: "text",
      visibility: "agent-only",
      text: expect.stringContaining("Issue ISS-43 details (resolve call 2)"),
    });
    expect(queued.command.input[0]).toMatchObject({
      type: "text",
      text: "@Fix login bug then @Fix login bug then @Ship mention providers",
    });
  });

  it("resolves plugin mentions when a queued message dispatches on the idle-provider fast path", async () => {
    const { thread } = seedWarmIdleThreadFixture(harness, 5);
    const queued = seedQueuedMessage(harness.deps, {
      threadId: thread.id,
      content: pluginMentionInput({
        text: "@Fix login bug",
        mentions: [{ label: "Fix login bug", itemId: "issues:ISS-42" }],
      }),
    });

    await sendQueuedMessage(harness.deps, {
      claimPolicy: {
        kind: "automatic",
        isGroupEligible: () => true,
      },
      threadId: thread.id,
      queuedMessageId: queued.id,
      mode: "auto",
    });

    const dispatched = await waitForQueuedCommand(
      harness,
      (candidate) =>
        candidate.command.type === "turn.submit" &&
        candidate.command.threadId === thread.id,
    );
    if (dispatched.command.type !== "turn.submit") {
      throw new Error("Expected a turn.submit command");
    }
    const agentOnly = dispatched.command.input.filter(
      (item) => item.type === "text" && item.visibility === "agent-only",
    );
    expect(agentOnly).toHaveLength(1);
    expect(agentOnly[0]).toMatchObject({
      type: "text",
      visibility: "agent-only",
      text: expect.stringContaining("Issue ISS-42 details"),
    });
    expect(dispatched.command.input[0]).toMatchObject({
      type: "text",
      text: "@Fix login bug",
    });
  });

  it("blocks the send with a 422 when resolve throws, and dispatches nothing", async () => {
    const { environment, thread } = seedColdIdleThreadFixture(harness, 2);

    await expect(
      sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: pluginMentionInput({
            text: "@Onboarding guide",
            mentions: [
              { label: "Onboarding guide", itemId: "docs:onboarding" },
            ],
          }),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      }),
    ).rejects.toMatchObject({
      status: 422,
      body: {
        code: "plugin_mention_resolve_failed",
        message: expect.stringContaining("docs resolve boom"),
      },
    });

    expect(
      listQueuedThreadCommands(harness, "thread.start", thread.id),
    ).toHaveLength(0);
    expect(
      listQueuedThreadCommands(harness, "turn.submit", thread.id),
    ).toHaveLength(0);
  });

  it("blocks the send when the mentioned plugin is not running or the item id is malformed", async () => {
    const { environment, thread } = seedColdIdleThreadFixture(harness, 3);
    const basePayload = {
      mode: "start" as const,
      model: "gpt-5",
      permissionMode: "full" as const,
      reasoningLevel: "medium" as const,
      serviceTier: "default" as const,
    };

    await harness.pluginService.setEnabled("mentions", false);
    await expect(
      sendThreadMessage(harness.deps, {
        environment,
        payload: {
          ...basePayload,
          input: pluginMentionInput({
            text: "@Fix login bug",
            mentions: [{ label: "Fix login bug", itemId: "issues:ISS-42" }],
          }),
        },
        thread,
        trigger: "user",
      }),
    ).rejects.toMatchObject({
      body: {
        code: "plugin_mention_resolve_failed",
        message: expect.stringContaining("not running"),
      },
    });
    await harness.pluginService.setEnabled("mentions", true);

    await expect(
      sendThreadMessage(harness.deps, {
        environment,
        payload: {
          ...basePayload,
          input: pluginMentionInput({
            text: "@Malformed",
            mentions: [{ label: "Malformed", itemId: "no-provider-prefix" }],
          }),
        },
        thread,
        trigger: "user",
      }),
    ).rejects.toMatchObject({
      body: { code: "plugin_mention_resolve_failed" },
    });

    await expect(
      sendThreadMessage(harness.deps, {
        environment,
        payload: {
          ...basePayload,
          input: pluginMentionInput({
            text: "@Broken",
            mentions: [{ label: "Broken", itemId: "broken:anything" }],
          }),
        },
        thread,
        trigger: "user",
      }),
    ).rejects.toMatchObject({
      body: {
        code: "plugin_mention_resolve_failed",
        message: expect.stringContaining("must return { context: string }"),
      },
    });
  });

  it("rejects duplicate and malformed provider registrations at load", async () => {
    const dupeDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      {
        name: "bb-plugin-dupe-mentions",
        serverSource: `
          export default function plugin(bb: any) {
            bb.ui.registerMentionProvider({
              id: "a", label: "A", search: () => [], resolve: () => ({ context: "x" }),
            });
            bb.ui.registerMentionProvider({
              id: "a", label: "A again", search: () => [], resolve: () => ({ context: "x" }),
            });
          }
        `,
      },
    );
    const dupe = await harness.pluginService.installPath(dupeDir);
    expect(dupe.status).toBe("error");
    expect(dupe.statusDetail).toContain(
      'mention provider "a" is already registered',
    );

    const badIdDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      {
        name: "bb-plugin-bad-mention-id",
        serverSource: `
          export default function plugin(bb: any) {
            bb.ui.registerMentionProvider({
              id: "has:colon", label: "Nope", search: () => [], resolve: () => ({ context: "x" }),
            });
          }
        `,
      },
    );
    const badId = await harness.pluginService.installPath(badIdDir);
    expect(badId.status).toBe("error");
    expect(badId.statusDetail).toContain("invalid mention provider id");

    const badTriggerDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      {
        name: "bb-plugin-bad-mention-trigger",
        serverSource: `
          export default function plugin(bb: any) {
            bb.ui.registerMentionProvider({
              id: "bad", label: "Nope", triggers: ["?"], search: () => [], resolve: () => ({ context: "x" }),
            });
          }
        `,
      },
    );
    const badTrigger = await harness.pluginService.installPath(badTriggerDir);
    expect(badTrigger.status).toBe("error");
    expect(badTrigger.statusDetail).toContain(
      'mention provider "bad" trigger "?" is invalid',
    );
  });
});

describe("mention search time box", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-mention-timeout-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      mentionSearchTimeoutMs: 100,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("drops a slow provider after the time box and keeps fast providers", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-slow-mentions",
      serverSource: `
        export default function plugin(bb: any) {
          bb.ui.registerMentionProvider({
            id: "fast",
            label: "Fast",
            search: () => [{ id: "one", title: "One" }],
            resolve: () => ({ context: "one" }),
          });
          bb.ui.registerMentionProvider({
            id: "slow",
            label: "Slow",
            search: () => new Promise((resolve) => {
              setTimeout(() => resolve([{ id: "late", title: "Late" }]), 1000);
            }),
            resolve: () => ({ context: "late" }),
          });
        }
      `,
    });
    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("running");

    const groups = await service.searchMentions({
      trigger: "@",
      query: "o",
      projectId: null,
      threadId: null,
    });
    expect(groups).toEqual([
      {
        pluginId: "slow-mentions",
        providerId: "fast",
        label: "Fast",
        items: [
          { itemId: "fast:one", title: "One", subtitle: null, icon: null },
        ],
      },
    ]);
    const listEntry = service
      .list()
      .find((plugin) => plugin.id === "slow-mentions");
    expect(listEntry?.handlerStats.errorCount).toBe(1);
  });
});

describe("mention resolve time box", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-resolve-timeout-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      mentionResolveTimeoutMs: 100,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("fails the resolve after the time box instead of hanging the send", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-slow-resolve",
      serverSource: `
        export default function plugin(bb: any) {
          bb.ui.registerMentionProvider({
            id: "stuck",
            label: "Stuck",
            search: () => [{ id: "one", title: "One" }],
            // Never settles: without the time box this would hang
            // POST /threads/:id/send indefinitely.
            resolve: () => new Promise(() => {}),
          });
        }
      `,
    });
    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("running");

    const result = await service.resolveMention({
      pluginId: "slow-resolve",
      itemId: "stuck:one",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("timed out after 100ms"),
    });
    const listEntry = service
      .list()
      .find((plugin) => plugin.id === "slow-resolve");
    expect(listEntry?.handlerStats.errorCount).toBe(1);
  });
});
