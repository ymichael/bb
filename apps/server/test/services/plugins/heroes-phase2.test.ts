import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import type { PromptInput } from "@bb/domain";
import { buildThreadStartCommand } from "../../../src/services/threads/thread-commands.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME } from "../../../src/services/threads/thread-environment-directory.js";
import { resolveExecutionOptions } from "../../../src/services/threads/thread-runtime-config.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { readJson } from "../../helpers/json.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const EXAMPLES_DIR = fileURLToPath(
  new URL("../../../../../examples/plugins", import.meta.url),
);

const APP_VERSION = "1.0.0";

describe("hero plugin: agent-enrichment (Phase 2 surfaces)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness({ appVersion: APP_VERSION });
    const entry = await harness.pluginService.installPath(
      join(EXAMPLES_DIR, "agent-enrichment"),
    );
    expect(entry.id).toBe("agent-enrichment");
    expect(entry.statusDetail).toBeNull();
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  function seedThreadFixture(value: number) {
    const { host, session } = seedHostSession(harness.deps, {
      id: `host-enrichment-${value}`,
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: `/tmp/enrichment-${value}`,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: `/tmp/enrichment-${value}`,
      status: "ready",
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "idle",
    });
    return { environment, project, session, thread };
  }

  it("docs_search and the repo-conventions skill ride thread.start", async () => {
    const { environment, project, thread } = seedThreadFixture(1);
    const execution = await resolveExecutionOptions(harness.deps, {
      threadId: thread.id,
      requestedExecution: { model: "gpt-5", source: "client/turn/requested" },
    });
    const command = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello"),
      projectId: project.id,
      providerId: "codex",
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      syncGeneratedTitle: false,
      thread,
    });

    expect(command.dynamicTools.map((tool) => tool.name)).toEqual([
      UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
      "docs_search",
    ]);
    const docsSearch = command.dynamicTools.find(
      (tool) => tool.name === "docs_search",
    );
    expect(docsSearch?.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(command.instructions).toContain(
      'The following instructions come from the BB plugin "agent-enrichment" for its tool "docs_search":',
    );
    expect(command.instructions).toContain(
      "Use the docs_search tool to look up repo conventions",
    );

    expect(command.injectedSkillSources).toContainEqual(
      expect.objectContaining({
        kind: "tree",
        name: "repo-conventions",
        entryPath: "SKILL.md",
      }),
    );
  });

  it("the internal tool-call route dispatches docs_search; the CLI command shares its kv cache", async () => {
    const { session, thread } = seedThreadFixture(2);
    const postToolCall = (args: unknown) =>
      harness.app.request("/internal/session/tool-call", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          threadId: thread.id,
          providerThreadId: "provider-enrichment",
          turnId: "turn-enrichment",
          callId: "call-enrichment",
          tool: "docs_search",
          arguments: args,
        }),
      });

    const response = await postToolCall({ query: "conventional commits" });
    expect(response.status).toBe(200);
    const result = (await readJson(response)) as {
      success: boolean;
      contentItems: Array<{ text: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.contentItems[0].text).toContain("conventions.md");
    expect(result.contentItems[0].text).toContain("conventional commits");

    const invalid = await postToolCall({});
    const invalidResult = (await readJson(invalid)) as {
      success: boolean;
      contentItems: Array<{ text: string }>;
    };
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.contentItems[0].text).toContain(
      'Invalid arguments for tool "docs_search"',
    );
    expect(
      harness.pluginService
        .list()
        .find((plugin) => plugin.id === "agent-enrichment")?.handlerStats
        .errorCount,
    ).toBe(0);

    const last = await harness.app.request(
      "http://127.0.0.1:3334/api/v1/plugins/agent-enrichment/cli",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ argv: ["last"] }),
      },
    );
    expect(last.status).toBe(200);
    const lastBody = (await last.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(lastBody.exitCode).toBe(0);
    expect(lastBody.stdout).toContain('"conventional commits"');
  });

  it("the docs mention provider searches titles and resolves the doc body at send", async () => {
    const search = await harness.app.request(
      "http://127.0.0.1:3334/api/v1/plugins/mentions/search?q=test",
    );
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as {
      ok: boolean;
      groups: unknown;
    };
    expect(searchBody.ok).toBe(true);
    expect(searchBody.groups).toEqual([
      {
        pluginId: "agent-enrichment",
        providerId: "docs",
        label: "Plugin docs",
        items: [
          {
            itemId: "docs:testing.md",
            title: "Testing",
            subtitle: "testing.md",
            icon: null,
          },
        ],
      },
    ]);

    const { environment, thread } = seedThreadFixture(3);
    const input: PromptInput[] = [
      {
        type: "text",
        text: "Follow @Repo conventions please",
        mentions: [
          {
            start: 7,
            end: 24,
            resource: {
              kind: "plugin",
              pluginId: "agent-enrichment",
              itemId: "docs:conventions.md",
              label: "Repo conventions",
            },
          },
        ],
      },
    ];
    await sendThreadMessage(harness.deps, {
      environment,
      payload: {
        input,
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
    expect(agentOnly).toHaveLength(1);
    expect(agentOnly[0]).toMatchObject({
      text: expect.stringContaining("conventional commits"),
    });
    expect(agentOnly[0]).toMatchObject({
      text: expect.stringContaining('resolved by plugin "agent-enrichment"'),
    });
  });

  it("mention resolve rejects item ids outside the docs dir, blocking the send", async () => {
    const { environment, thread } = seedThreadFixture(4);
    await expect(
      sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: [
            {
              type: "text",
              text: "@Sneaky",
              mentions: [
                {
                  start: 0,
                  end: 7,
                  resource: {
                    kind: "plugin",
                    pluginId: "agent-enrichment",
                    itemId: "docs:../server.ts",
                    label: "Sneaky",
                  },
                },
              ],
            },
          ],
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
        message: expect.stringContaining("unknown doc"),
      },
    });
    expect(
      listQueuedThreadCommands(harness, "thread.start", thread.id),
    ).toHaveLength(0);
  });
});
