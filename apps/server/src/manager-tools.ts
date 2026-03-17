import { toRecord } from "@bb/core";
import { ProviderToolHost, type ProviderToolDefinition } from "@bb/provider-adapters";
import { invalidRequestError } from "./domain-errors.js";
import type { Orchestrator } from "./orchestrator.js";

const MESSAGE_USER_TOOL_NAME = "message_user";

function parseMessageUserArguments(args: unknown): { message: string } {
  const record = toRecord(args);
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  if (message.length === 0) {
    throw invalidRequestError("message_user requires a non-empty message string");
  }
  return { message };
}

export function createManagerProviderToolHost(args: {
  getThreadManager: () => Orchestrator | undefined;
}): ProviderToolHost {
  const tools: ProviderToolDefinition[] = [
    {
      name: MESSAGE_USER_TOOL_NAME,
      description: "Send a user-visible message from the manager to the user.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to publish to the user.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async execute({ call, context }) {
        const threadManager = args.getThreadManager();
        if (!threadManager) {
          throw new Error("Manager tool host is unavailable");
        }
        const parsed = parseMessageUserArguments(call.arguments);
        await threadManager.messageUser(context.threadId, {
          text: parsed.message,
          toolCallId: call.callId,
          turnId: call.turnId,
        });
        return "Message sent to the user.";
      },
    },
  ];

  return new ProviderToolHost(tools);
}

export function composeProviderToolHosts(
  hosts: Array<ProviderToolHost | undefined>,
): ProviderToolHost | undefined {
  const availableHosts = hosts.filter((host): host is ProviderToolHost => host !== undefined);
  if (availableHosts.length === 0) {
    return undefined;
  }
  if (availableHosts.length === 1) {
    return availableHosts[0];
  }

  return {
    listTools() {
      const toolByName = new Map<string, ReturnType<ProviderToolHost["listTools"]>[number]>();
      for (const host of availableHosts) {
        for (const tool of host.listTools()) {
          toolByName.set(tool.name, tool);
        }
      }
      return Array.from(toolByName.values());
    },
    async execute(args) {
      for (const host of availableHosts) {
        if (host.listTools().some((tool) => tool.name === args.call.tool)) {
          return host.execute(args);
        }
      }
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `Unknown tool: ${args.call.tool}`,
          },
        ],
      };
    },
  } as ProviderToolHost;
}
