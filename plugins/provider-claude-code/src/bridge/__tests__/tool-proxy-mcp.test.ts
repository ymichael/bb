import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildBridgeMcpServer } from "../tool-proxy-mcp.js";

const RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    value: {
      type: "object",
      required: ["verdict", "blockers"],
      properties: {
        verdict: { enum: ["merge", "do-not-merge"] },
        blockers: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
          },
        },
      },
    },
  },
  required: ["value"],
  additionalProperties: false,
};

async function connect(server: ReturnType<typeof buildBridgeMcpServer>) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("buildBridgeMcpServer", () => {
  it("serves registered JSON schemas verbatim over tools/list", async () => {
    const server = buildBridgeMcpServer(
      [
        {
          name: "bb_workflow_result",
          description: "Return the structured result.",
          inputSchema: RESULT_SCHEMA,
        },
        {
          name: "bb_odd_tool",
          description: "Tool registered with a non-object schema.",
          inputSchema: { type: "string" },
        },
      ],
      async () => ({ content: "unused" }),
    );
    const client = await connect(server);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(2);
    expect(listed.tools[0]).toMatchObject({
      name: "bb_workflow_result",
      description: "Return the structured result.",
      inputSchema: RESULT_SCHEMA,
    });
    expect(listed.tools[1]?.inputSchema).toEqual({ type: "object" });
    await client.close();
  });

  it("forwards tool calls with raw arguments and reports errors", async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> =
      [];
    const server = buildBridgeMcpServer(
      [
        {
          name: "bb_workflow_result",
          description: "Return the structured result.",
          inputSchema: RESULT_SCHEMA,
        },
      ],
      async (toolName, args) => {
        calls.push({ toolName, args });
        return { content: '{"accepted":true}' };
      },
    );
    const client = await connect(server);

    const result = await client.callTool({
      name: "bb_workflow_result",
      arguments: { value: { verdict: "merge", blockers: [] } },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: '{"accepted":true}' }],
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        toolName: "bb_workflow_result",
        args: { value: { verdict: "merge", blockers: [] } },
      },
    ]);

    const unknown = await client.callTool({
      name: "bb_missing",
      arguments: {},
    });
    expect(unknown).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Unknown tool: bb_missing" }],
    });
    await client.close();
  });

  it("serves an image-only tool result as an MCP image block", async () => {
    const server = buildBridgeMcpServer(
      [
        {
          name: "browser_screenshot",
          description: "A PNG of the current page.",
          inputSchema: { type: "object" },
        },
      ],
      async () => ({
        content: "",
        contentBlocks: [
          {
            type: "image" as const,
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      }),
    );
    const client = await connect(server);

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: {},
    });
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    await client.close();
  });
});
