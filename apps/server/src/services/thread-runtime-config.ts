import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getDefaultProjectSource,
  getProject,
} from "@bb/db";
import type {
  DynamicTool,
  Environment,
  Thread,
} from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import type { AppDeps } from "../types.js";

const MANAGER_PREFERENCES_FILE_NAME = "PREFERENCES.md";
const NO_MANAGER_PREFERENCES = "No preferences yet.";

const MESSAGE_USER_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description: "User-visible message text.",
    },
  },
  required: ["text"],
};

const SPAWN_THREAD_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: {
      type: "string",
      description: "Primary task prompt for the child thread.",
    },
    environmentId: {
      type: "string",
      description: "Existing environment to reuse for the child thread.",
    },
    hostId: {
      type: "string",
      description: "Host to run the child thread on when creating a new environment.",
    },
    providerId: {
      type: "string",
      description: "Provider for the child thread.",
    },
    type: {
      type: "string",
      enum: ["standard", "manager"],
      description: "Thread type for the child thread.",
    },
    title: {
      type: "string",
      description: "Human-readable child thread title.",
    },
    model: {
      type: "string",
      description: "Model override for the child thread.",
    },
    reasoningLevel: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh"],
      description: "Reasoning effort for the child thread.",
    },
    sandboxMode: {
      type: "string",
      enum: ["read-only", "workspace-write", "danger-full-access"],
      description: "Sandbox mode for the child thread.",
    },
  },
  required: ["prompt"],
};

const MANAGER_DYNAMIC_TOOLS: DynamicTool[] = [
  {
    name: "message_user",
    description: "Send a user-visible update from the manager thread.",
    inputSchema: MESSAGE_USER_TOOL_SCHEMA,
  },
  {
    name: "spawn_thread",
    description: "Create a BB child thread to own substantive work.",
    inputSchema: SPAWN_THREAD_TOOL_SCHEMA,
  },
];

export interface ResolveThreadRuntimeConfigArgs {
  environment: Pick<Environment, "path">;
  thread: Pick<Thread, "id" | "projectId" | "type">;
}

export interface ThreadRuntimeConfig {
  dynamicTools?: DynamicTool[];
  instructions?: string;
}

async function readManagerPreferences(managerWorkspacePath: string): Promise<string> {
  const preferencesPath = path.join(
    managerWorkspacePath,
    MANAGER_PREFERENCES_FILE_NAME,
  );
  try {
    return await readFile(preferencesPath, "utf8");
  } catch {
    return NO_MANAGER_PREFERENCES;
  }
}

async function buildManagerRuntimeConfig(
  deps: Pick<AppDeps, "db">,
  args: ResolveThreadRuntimeConfigArgs,
): Promise<ThreadRuntimeConfig> {
  const project = getProject(deps.db, args.thread.projectId);
  if (!project) {
    throw new Error(`Project ${args.thread.projectId} was not found`);
  }

  const defaultSource = getDefaultProjectSource(deps.db, args.thread.projectId);
  const managerWorkspacePath = args.environment.path ?? "";
  const projectRootPath = defaultSource?.path ?? managerWorkspacePath;

  return {
    dynamicTools: MANAGER_DYNAMIC_TOOLS,
    instructions: renderTemplate("managerAgentInstructions", {
      managerPreferencesContent: managerWorkspacePath
        ? await readManagerPreferences(managerWorkspacePath)
        : NO_MANAGER_PREFERENCES,
      managerThreadId: args.thread.id,
      managerWorkspacePath,
      projectId: project.id,
      projectName: project.name,
      projectRootPath,
    }),
  };
}

export async function resolveThreadRuntimeConfig(
  deps: Pick<AppDeps, "db">,
  args: ResolveThreadRuntimeConfigArgs,
): Promise<ThreadRuntimeConfig> {
  if (args.thread.type !== "manager") {
    return {};
  }

  return buildManagerRuntimeConfig(deps, args);
}
