import { expect } from "vitest";
import type { Thread } from "@bb/core";
import { ProviderToolHost } from "@bb/provider-adapters";
import {
  createProject,
  listThreadEvents,
  readJson,
  waitForThreadCondition,
} from "./environment-agent-api.js";
import { startDaemonE2eHarness } from "./harness.js";

export async function runDynamicToolsDaemonRoundtripScenario(): Promise<void> {
  const toolCalls: string[] = [];
  const toolHost = new ProviderToolHost([
    {
      name: "echo_test_tool",
      description:
        "Return the exact input message verbatim. Use this tool when instructed to echo a message.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      execute: ({ call }) => {
        toolCalls.push(call.tool);
        const args =
          call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
            ? (call.arguments as { message?: unknown })
            : {};
        return String(args.message ?? "");
      },
    },
  ]);
  const harness = await startDaemonE2eHarness({
    providerMode: "real",
    providerToolHost: toolHost,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "e2e-daemon-dynamic-tools-project",
    );
    const thread = await readJson<Thread>(`${harness.baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        input: [
          {
            type: "text",
            text:
              'Use echo_test_tool with message "from-daemon-dynamic". After the tool returns, reply with exactly the returned text and nothing else.',
          },
        ],
      }),
    });

    const completedThread = await waitForThreadCondition({
      threadId: thread.id,
      timeoutMs: 120_000,
      wsUrl: harness.wsUrl,
      load: () => readJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`),
      isReady: (candidate) => candidate.status === "idle",
      describeLast: (candidate) =>
        `Thread ${thread.id} did not reach idle (last status=${candidate?.status ?? "unknown"})`,
    });
    expect(completedThread.status).toBe("idle");

    const [{ output }, events] = await Promise.all([
      readJson<{ output: string | null }>(`${harness.baseUrl}/api/v1/threads/${thread.id}/output`),
      listThreadEvents(harness.baseUrl, thread.id),
    ]);

    expect(toolCalls).toContain("echo_test_tool");
    expect(output?.toLowerCase()).toContain("from-daemon-dynamic");
    expect(events.some((event) => event.type === "item/completed")).toBe(true);
  } finally {
    await harness.cleanup();
  }
}
