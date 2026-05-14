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
  /** On the project's new manager form. */
  isNewManagerView: boolean;
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
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectThreadMatch = useMatch(
    "/projects/:projectId/threads/:threadId/*",
  );
  const projectArchivedMatch = useMatch("/projects/:projectId/archived");
  const projectNewManagerMatch = useMatch("/projects/:projectId/managers/new");
  const projectSettingsMatch = useMatch("/projects/:projectId/settings");

  const isThreadView = Boolean(projectThreadMatch);
  const isArchivedView = Boolean(projectArchivedMatch);
  const isNewManagerView = Boolean(projectNewManagerMatch);
  const isSettingsView = Boolean(projectSettingsMatch);
  const isProjectMainView = Boolean(
    projectMatch &&
    !isThreadView &&
    !isArchivedView &&
    !isNewManagerView &&
    !isSettingsView,
  );

  return {
    projectId: projectMatch?.params.projectId,
    threadId: projectThreadMatch?.params.threadId,
    isProjectMainView,
    isThreadView,
    isArchivedView,
    isNewManagerView,
    isSettingsView,
    isRootView: location.pathname === "/",
  };
}
