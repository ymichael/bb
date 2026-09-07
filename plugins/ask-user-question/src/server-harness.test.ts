import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin, { RENDERER_ID, TOOL_NAME } from "./server.js";
import { TOOL_INPUT_JSON_SCHEMA } from "./tool-definition.js";
import type { InteractionPayload, ToolResult } from "./contracts.js";

function createHost(): FakePluginHost {
  const host = createFakePluginHost({ pluginId: "ask-user-question" });
  plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
  return host;
}

function configurationContext(
  providerId: string,
  supportsNativeUserQuestion = false,
) {
  return makePluginAgentConfigurationContext({
    provider: {
      id: providerId,
      capabilities: { supportsNativeUserQuestion },
    },
  });
}

const questions = [
  {
    question: "Which database should we use?",
    header: "Database",
    multiSelect: false,
    options: [
      {
        label: "Postgres (Recommended)",
        description: "Relational, needs a server.",
        preview: "CREATE TABLE users (id uuid primary key);",
      },
      { label: "SQLite", description: "Embedded, zero setup." },
    ],
  },
];

async function resultText(
  result: Awaited<ReturnType<FakePluginHost["harness"]["callAgentTool"]>>,
): Promise<string> {
  if (typeof result === "string") return result;
  const [part] = result.content;
  if (part?.type !== "text") throw new Error("expected a text result");
  return part.text;
}

describe("provider gating", () => {
  it.each(["claude-code", "some-plugin-provider"])(
    "withholds the tool from %s, which declares it natively",
    async (providerId) => {
      const host = createHost();
      const resolved = await host.harness.resolveAgentConfiguration(
        configurationContext(providerId, true),
      );
      expect(resolved.tools).toEqual([]);
    },
  );

  it.each(["codex", "pi", "acp-cursor"])(
    "registers the tool for %s with Claude's exact advertised schema",
    async (providerId) => {
      const host = createHost();
      const resolved = await host.harness.resolveAgentConfiguration(
        configurationContext(providerId),
      );
      expect(resolved.tools).toHaveLength(1);
      const [tool] = resolved.tools;
      expect(tool?.name).toBe(TOOL_NAME);
      expect(tool?.inputSchema).toEqual(TOOL_INPUT_JSON_SCHEMA);
    },
  );

  it("advertises multiSelect as required even though execution defaults it", async () => {
    const host = createHost();
    const resolved = await host.harness.resolveAgentConfiguration(
      configurationContext("codex"),
    );
    const schema = resolved.tools[0]?.inputSchema as {
      properties: {
        questions: { items: { required: string[] } };
      };
    };
    expect(schema.properties.questions.items.required).toContain("multiSelect");

    const answered = host.harness.callAgentTool(TOOL_NAME, {
      questions: [{ ...questions[0], multiSelect: undefined }],
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    host.harness.submitInteraction(pending.id, {
      answers: { q0: { selected: ["q0o1"] } },
    });
    await answered;
  });
});

describe("asking a question", () => {
  it("opens an interaction and returns the answer in Claude's result shape", async () => {
    const host = createHost();
    const call = host.harness.callAgentTool(TOOL_NAME, { questions });

    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending.rendererId).toBe(RENDERER_ID);
    expect(pending.title).toBe("Database");
    const payload = pending.payload as InteractionPayload;
    expect(payload.questions[0]).toMatchObject({
      id: "q0",
      prompt: "Which database should we use?",
      shortLabel: "Database",
      allowFreeText: true,
    });

    host.harness.submitInteraction(pending.id, {
      answers: { q0: { selected: ["q0o0"], freeText: "with pgbouncer" } },
    });

    const parsed = JSON.parse(await resultText(await call)) as ToolResult;
    expect(parsed.answers).toEqual({
      "Which database should we use?": "Postgres (Recommended); with pgbouncer",
    });
    expect(parsed.annotations?.["Which database should we use?"]).toEqual({
      preview: "CREATE TABLE users (id uuid primary key);",
      notes: "with pgbouncer",
    });
  });

  it("tells the model to carry on when the user dismisses the question", async () => {
    const host = createHost();
    const call = host.harness.callAgentTool(TOOL_NAME, { questions });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);

    const result = await call;
    expect(result).toMatchObject({ isError: true });
    expect(await resultText(result)).toContain("dismissed the question");
  });

  it("reports an empty submission as an error instead of a blank answer", async () => {
    const host = createHost();
    const call = host.harness.callAgentTool(TOOL_NAME, { questions });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      answers: { q0: { selected: [] } },
    });

    const result = await call;
    expect(result).toMatchObject({ isError: true });
    expect(await resultText(result)).toContain("no answers");
  });

  it("explains the collision when a second question races the first", async () => {
    const host = createFakePluginHost({ pluginId: "ask-user-question" });
    host.bb.ui.requestInput = () =>
      Promise.reject(
        new Error("Thread thr-test is already awaiting user interaction"),
      );
    plugin(host.bb as unknown as Parameters<typeof plugin>[0]);

    const result = await host.harness.callAgentTool(TOOL_NAME, { questions });

    expect(result).toMatchObject({ isError: true });
    const text = await resultText(result);
    expect(text).toContain("already awaiting user interaction");
    expect(text).toContain("Only one prompt can await the user at a time");
  });

  it("rejects oversized previews before opening an interaction", async () => {
    const host = createHost();
    const preview = "x".repeat(4096);
    const result = await host.harness.callAgentTool(TOOL_NAME, {
      questions: Array.from({ length: 4 }, (_unused, index) => ({
        question: `Question ${index}?`,
        header: `Q${index}`,
        multiSelect: false,
        options: Array.from({ length: 4 }, (_option, optionIndex) => ({
          label: `Option ${optionIndex}`,
          description: "Detail.",
          preview,
        })),
      })),
    });

    expect(result).toMatchObject({ isError: true });
    expect(await resultText(result)).toContain("too large to display");
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });
});
