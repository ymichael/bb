import { mkdirSync } from "node:fs";
import { resolveBeanbagPath } from "@beanbag/agent-core/storage-paths";
import { renderTemplate } from "@beanbag/templates";

export const MANAGER_THREAD_TITLE = "Manager";

export const MANAGER_WELCOME_MESSAGE = "[bb system] Welcome!";
export const MANAGER_WORKSPACE_PATH_PLACEHOLDER = "{{MANAGER_WORKSPACE_PATH}}";
export const MANAGER_PREFERENCES_CONTENT_PLACEHOLDER = "{{MANAGER_PREFERENCES_CONTENT}}";

export function resolveManagerWorkspacePath(
  runtimeEnv: NodeJS.ProcessEnv,
  threadId: string,
): string {
  return resolveBeanbagPath(runtimeEnv, "workspace", threadId);
}

export function ensureManagerWorkspace(
  runtimeEnv: NodeJS.ProcessEnv,
  threadId: string,
): string {
  const workspacePath = resolveManagerWorkspacePath(runtimeEnv, threadId);
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

export function buildManagerDeveloperInstructions(
): string {
  return renderTemplate("managerAgentInstructions", {
    managerPreferencesContent: MANAGER_PREFERENCES_CONTENT_PLACEHOLDER,
    managerWorkspacePath: MANAGER_WORKSPACE_PATH_PLACEHOLDER,
  });
}
