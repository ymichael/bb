import type {
  ProviderDynamicTool,
  ProviderThreadContext,
  ProviderToolCallRequest,
  ProviderToolCallResponse,
} from "@bb/core";

export interface ProviderToolDefinition extends ProviderDynamicTool {
  execute(args: {
    call: ProviderToolCallRequest;
    context: ProviderThreadContext;
  }):
    | Promise<ProviderToolCallResponse | string | unknown>
    | ProviderToolCallResponse
    | string
    | unknown;
}

export class ProviderToolHost {
  private readonly toolByName = new Map<string, ProviderToolDefinition>();

  constructor(private readonly tools: ProviderToolDefinition[]) {
    for (const tool of tools) {
      this.toolByName.set(tool.name, tool);
    }
  }

  listTools(): ProviderDynamicTool[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(args: {
    call: ProviderToolCallRequest;
    context: ProviderThreadContext;
  }): Promise<ProviderToolCallResponse> {
    const tool = this.toolByName.get(args.call.tool);
    if (!tool) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `Unknown tool: ${args.call.tool}`,
          },
        ],
      };
    }

    try {
      const result = await tool.execute(args);
      return normalizeProviderToolResult(result, tool.name);
    } catch (error) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `Tool ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}

function normalizeProviderToolResult(
  result: ProviderToolCallResponse | string | unknown,
  toolName: string,
): ProviderToolCallResponse {
  if (isProviderToolCallResponse(result)) {
    return result;
  }

  if (typeof result === "string") {
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: result,
        },
      ],
    };
  }

  if (result !== undefined) {
    try {
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch {
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: String(result),
          },
        ],
      };
    }
  }

  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: `Tool ${toolName} completed.`,
      },
    ],
  };
}

function isProviderToolCallResponse(
  value: unknown,
): value is ProviderToolCallResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const response = value as Partial<ProviderToolCallResponse>;
  return Array.isArray(response.contentItems) && typeof response.success === "boolean";
}
