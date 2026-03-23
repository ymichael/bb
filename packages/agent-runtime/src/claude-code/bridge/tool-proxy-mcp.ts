import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

export const BRIDGE_MCP_SERVER_NAME = "bb-bridge";

export interface DynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type ToolCallForwarder = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError?: boolean }>;

export function buildBridgeMcpServer(
  dynamicTools: DynamicToolDefinition[],
  forwardToolCall: ToolCallForwarder,
): McpSdkServerConfigWithInstance {
  const mcpTools = dynamicTools.map((def) => {
    return tool(
      def.name,
      def.description,
      buildZodShape(def.inputSchema),
      async (args) => {
        const result = await forwardToolCall(
          def.name,
          args as Record<string, unknown>,
        );
        return {
          content: [{ type: "text" as const, text: result.content }],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    );
  });

  return createSdkMcpServer({
    name: BRIDGE_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: mcpTools,
  });
}

export function getAllowedToolNames(
  dynamicTools: DynamicToolDefinition[],
): string[] {
  return dynamicTools.map(
    (def) => `mcp__${BRIDGE_MCP_SERVER_NAME}__${def.name}`,
  );
}

function buildZodShape(
  inputSchema: unknown,
): z.ZodRawShape {
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    !("properties" in inputSchema)
  ) {
    return {};
  }

  const schema = inputSchema as {
    properties?: Record<string, { type?: string }>;
  };

  if (!schema.properties) return {};

  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    switch (prop?.type) {
      case "string":
        shape[key] = z.string().optional();
        break;
      case "number":
      case "integer":
        shape[key] = z.number().optional();
        break;
      case "boolean":
        shape[key] = z.boolean().optional();
        break;
      default:
        shape[key] = z.unknown().optional();
        break;
    }
  }

  return shape as z.ZodRawShape;
}
