import { useLocation, useMatch } from "react-router-dom";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { isToolsRoutePath, TOOLS_SKILLS_ROUTE_PATH } from "@/lib/route-paths";

interface RouteState {
  projectId: string | undefined;
  threadId: string | undefined;
  isThreadView: boolean;
  isArchivedView: boolean;
  isSettingsView: boolean;
  isToolsView: boolean;
  isSkillsView: boolean;
  isRootView: boolean;
  isProjectlessView: boolean;
}

export function useRouteState(): RouteState {
  const location = useLocation();
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectThreadMatch = useMatch(
    "/projects/:projectId/threads/:threadId/*",
  );
  const projectlessThreadMatch = useMatch("/threads/:threadId/*");
  const projectlessArchivedMatch = useMatch("/archived");
  const projectArchivedMatch = useMatch("/projects/:projectId/archived");
  const projectSettingsMatch = useMatch("/projects/:projectId/settings");
  const isToolsPath =
    isToolsRoutePath(location.pathname) ||
    location.pathname === "/tools" ||
    location.pathname.startsWith("/tools/");
  const isRootView = location.pathname === "/";
  const isUnsupportedPersonalProjectThread =
    projectThreadMatch?.params.projectId === PERSONAL_PROJECT_ID;
  const projectlessThreadId = projectlessThreadMatch?.params.threadId;
  const threadId =
    projectlessThreadId ??
    (isUnsupportedPersonalProjectThread
      ? undefined
      : projectThreadMatch?.params.threadId);
  const projectRouteProjectId = projectMatch?.params.projectId;
  const projectId =
    projectlessThreadId !== undefined || Boolean(projectlessArchivedMatch)
      ? PERSONAL_PROJECT_ID
      : isUnsupportedPersonalProjectThread
        ? undefined
        : projectRouteProjectId;

  return {
    projectId,
    threadId,
    isThreadView:
      Boolean(projectlessThreadMatch) ||
      (Boolean(projectThreadMatch) && !isUnsupportedPersonalProjectThread),
    isArchivedView:
      Boolean(projectArchivedMatch) || Boolean(projectlessArchivedMatch),
    isSettingsView: Boolean(projectSettingsMatch),
    isToolsView:
      isToolsPath ||
      location.pathname === "/skills" ||
      location.pathname === "/automations",
    isSkillsView:
      location.pathname === TOOLS_SKILLS_ROUTE_PATH ||
      location.pathname === "/skills",
    isRootView,
    isProjectlessView:
      isRootView ||
      projectlessThreadId !== undefined ||
      Boolean(projectlessArchivedMatch),
  };
}
