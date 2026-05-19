import { useLocation, useMatch } from "react-router-dom";

export interface AppRouteState {
  /** ID of the project in view (any project-scoped route), else undefined. */
  projectId: string | undefined;
  /** ID of the thread in view (thread detail only), else undefined. */
  threadId: string | undefined;
  /** On `/projects/:id` — not a thread, archived, or settings subroute. */
  isProjectMainView: boolean;
  /** On a thread detail URL. */
  isThreadView: boolean;
  /** On the project's archived threads list. */
  isArchivedView: boolean;
  /** On the project settings page. */
  isSettingsView: boolean;
  /** On the app root ("/"). */
  isRootView: boolean;
}

/**
 * Single source of truth for URL → logical route state. All route pattern
 * matching for "what view are we in" happens here so that shifts in the route
 * schema have one place to update instead of N scattered `useMatch` calls.
 */
export function useAppRoute(): AppRouteState {
  const location = useLocation();
  // Wildcard match exists only to extract `projectId` from any
  // project-scoped subroute; specific-view detection uses exact matches so a
  // new subroute doesn't accidentally count as "project main".
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectMainMatch = useMatch("/projects/:projectId");
  const projectThreadMatch = useMatch(
    "/projects/:projectId/threads/:threadId/*",
  );
  const projectArchivedMatch = useMatch("/projects/:projectId/archived");
  const projectSettingsMatch = useMatch("/projects/:projectId/settings");

  return {
    projectId: projectMatch?.params.projectId,
    threadId: projectThreadMatch?.params.threadId,
    isProjectMainView: Boolean(projectMainMatch),
    isThreadView: Boolean(projectThreadMatch),
    isArchivedView: Boolean(projectArchivedMatch),
    isSettingsView: Boolean(projectSettingsMatch),
    isRootView: location.pathname === "/",
  };
}
