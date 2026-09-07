import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { builtinPluginSource } from "../../../src/services/plugins/builtin-registry.js";
import { buildThreadStartCommand } from "../../../src/services/threads/thread-commands.js";
import { resolveExecutionOptions } from "../../../src/services/threads/thread-runtime-config.js";
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

describe("ask-user-question builtin plugin", () => {
  let harness: TestAppHarness;
  let requestValue = 1;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    const entry = await harness.pluginService.install(
      builtinPluginSource("ask-user-question"),
      { kind: "root" },
    );
    expect(entry.statusDetail ?? "").toBe("");
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  async function dynamicToolsFor(args: {
    providerId: string;
    model: string;
    label: string;
  }) {
    const { host } = seedHostSession(harness.deps, {
      id: `host-${args.label}`,
      name: `Host ${args.label}`,
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      name: args.label,
      path: join(harness.config.dataDir, args.label),
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, args.label),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: args.providerId,
    });
    const execution = await resolveExecutionOptions(harness.deps, {
      threadId: thread.id,
      requestedExecution: {
        model: args.model,
        source: "client/turn/requested",
      },
    });
    const command = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello"),
      projectId: project.id,
      providerId: args.providerId,
      requestId: encodeClientTurnRequestIdNumber({
        value: (requestValue += 1),
      }),
      syncGeneratedTitle: false,
      thread,
    });
    return command.dynamicTools;
  }

  it("advertises the tool to codex with Claude's exact schema", async () => {
    const tools = await dynamicToolsFor({
      providerId: "codex",
      model: "gpt-5.6",
      label: "codex-project",
    });
    const tool = tools.find(
      (candidate) => candidate.name === "AskUserQuestion",
    );

    expect(tool).toBeDefined();
    expect(tool?.description).toContain(
      "Use this tool only when you are blocked on a decision that is genuinely the user's to make",
    );
    const schema = tool?.inputSchema as {
      required: string[];
      properties: {
        questions: {
          minItems: number;
          maxItems: number;
          items: {
            required: string[];
            properties: {
              multiSelect: { default: boolean };
              options: {
                minItems: number;
                maxItems: number;
                items: { properties: Record<string, unknown> };
              };
            };
          };
        };
      };
    };
    expect(schema.required).toEqual(["questions"]);
    expect(schema.properties.questions.minItems).toBe(1);
    expect(schema.properties.questions.maxItems).toBe(4);
    expect(schema.properties.questions.items.required).toEqual([
      "question",
      "header",
      "options",
      "multiSelect",
    ]);
    expect(
      schema.properties.questions.items.properties.multiSelect.default,
    ).toBe(false);
    expect(schema.properties.questions.items.properties.options.minItems).toBe(
      2,
    );
    expect(schema.properties.questions.items.properties.options.maxItems).toBe(
      4,
    );
    expect(
      Object.keys(
        schema.properties.questions.items.properties.options.items.properties,
      ).sort(),
    ).toEqual(["description", "label", "preview"]);
    expect(Object.keys(schema.properties)).toEqual(["questions"]);
  });

  it("withholds the tool from claude-code, which asks natively", async () => {
    const tools = await dynamicToolsFor({
      providerId: "claude-code",
      model: "claude-opus-4-6",
      label: "claude-project",
    });

    expect(tools.map((tool) => tool.name)).not.toContain("AskUserQuestion");
  });
});
