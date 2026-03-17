import { mkdirSync } from "node:fs";
import { resolveBbPath } from "@bb/core/storage-paths";
import { renderTemplate } from "@bb/templates";

export const MANAGER_THREAD_TITLE = "Manager";

export const MANAGER_WELCOME_MESSAGE = "[bb system] Welcome!";
export const MANAGER_WORKSPACE_PATH_PLACEHOLDER = "{{MANAGER_WORKSPACE_PATH}}";
export const MANAGER_PREFERENCES_CONTENT_PLACEHOLDER = "{{MANAGER_PREFERENCES_CONTENT}}";
export const MANAGER_THREAD_ID_PLACEHOLDER = "{{MANAGER_THREAD_ID}}";
export const PROJECT_NAME_PLACEHOLDER = "{{PROJECT_NAME}}";
export const PROJECT_ID_PLACEHOLDER = "{{PROJECT_ID}}";
export const PROJECT_ROOT_PATH_PLACEHOLDER = "{{PROJECT_ROOT_PATH}}";

export function resolveManagerWorkspacePath(
  runtimeEnv: NodeJS.ProcessEnv,
  threadId: string,
): string {
  return resolveBbPath(runtimeEnv, "workspace", threadId);
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
  const bbSystemOverview = renderTemplate("bbSystemOverview", {} as Record<string, never>);
  const bbCliGuide = renderTemplate("bbCliGuide", {} as Record<string, never>);

  if (!bbSystemOverview) {
    throw new Error("bb system overview template rendered as empty");
  }
  if (!bbCliGuide) {
    throw new Error("bb CLI guide template rendered as empty");
  }

  return renderTemplate("managerAgentInstructions", {
    bbSystemOverview,
    bbCliGuide,
    managerPreferencesContent: MANAGER_PREFERENCES_CONTENT_PLACEHOLDER,
    managerThreadId: MANAGER_THREAD_ID_PLACEHOLDER,
    managerWorkspacePath: MANAGER_WORKSPACE_PATH_PLACEHOLDER,
    projectId: PROJECT_ID_PLACEHOLDER,
    projectName: PROJECT_NAME_PLACEHOLDER,
    projectRootPath: PROJECT_ROOT_PATH_PLACEHOLDER,
  });
}
