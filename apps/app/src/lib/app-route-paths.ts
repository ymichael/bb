export const APP_ROOT_ROUTE_PATH = "/";
export const AUTH_CALLBACK_ROUTE_PATH = "/auth/callback";
export const APP_SETTINGS_ROUTE_PATH = "/settings";
export const DEVELOPMENT_REPLAY_ROUTE_PATH = "/development-only/replay";
export const PROJECT_MAIN_ROUTE_PATH = "/projects/:projectId";
export const PROJECT_NEW_MANAGER_ROUTE_PATH =
  "/projects/:projectId/managers/new";
export const PROJECT_SETTINGS_ROUTE_PATH = "/projects/:projectId/settings";
export const PROJECT_ARCHIVED_ROUTE_PATH = "/projects/:projectId/archived";
export const THREAD_DETAIL_ROUTE_PATH =
  "/projects/:projectId/threads/:threadId";

const baseAppRoutePatterns = [
  APP_ROOT_ROUTE_PATH,
  AUTH_CALLBACK_ROUTE_PATH,
  APP_SETTINGS_ROUTE_PATH,
  PROJECT_MAIN_ROUTE_PATH,
  PROJECT_NEW_MANAGER_ROUTE_PATH,
  PROJECT_SETTINGS_ROUTE_PATH,
  PROJECT_ARCHIVED_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
] as const;

export const APP_ROUTE_PATTERNS = import.meta.env.DEV
  ? [...baseAppRoutePatterns, DEVELOPMENT_REPLAY_ROUTE_PATH]
  : baseAppRoutePatterns;
