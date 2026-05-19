import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { AuthCallbackView } from "./views/AuthCallbackView";
import { MainView } from "./views/MainView";
import { ProjectMainView } from "./views/ProjectMainView";
import { NewManagerDialogProvider } from "./hooks/useNewManagerDialog";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { useWebSocket } from "./hooks/useWebSocket";
import {
  APP_ROOT_ROUTE_PATH,
  APP_SETTINGS_ROUTE_PATH,
  AUTH_CALLBACK_ROUTE_PATH,
  DEVELOPMENT_REPLAY_ROUTE_PATH,
  PROJECT_ARCHIVED_ROUTE_PATH,
  PROJECT_MAIN_ROUTE_PATH,
  PROJECT_SETTINGS_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
} from "./lib/app-route-paths";

const ThreadDetailRoute = lazy(
  () => import("./views/thread-detail/ThreadDetailRoute"),
);
const AppSettingsView = lazy(() =>
  import("./views/AppSettingsView").then((m) => ({
    default: m.AppSettingsView,
  })),
);
const ProjectSettingsView = lazy(() =>
  import("./views/ProjectSettingsView").then((m) => ({
    default: m.ProjectSettingsView,
  })),
);
const ProjectArchivedThreadsView = lazy(() =>
  import("./views/ProjectArchivedThreadsView").then((m) => ({
    default: m.ProjectArchivedThreadsView,
  })),
);
const InternalReplayListView = lazy(() =>
  import("./views/InternalReplayListView").then((m) => ({
    default: m.InternalReplayListView,
  })),
);

function AppRoutes() {
  return (
    <AppLayout>
      <Suspense fallback={null}>
        <Routes>
          <Route path={APP_ROOT_ROUTE_PATH} element={<MainView />} />
          <Route path={APP_SETTINGS_ROUTE_PATH} element={<AppSettingsView />} />
          {import.meta.env.DEV ? (
            <Route
              path={DEVELOPMENT_REPLAY_ROUTE_PATH}
              element={<InternalReplayListView />}
            />
          ) : null}
          <Route path={PROJECT_MAIN_ROUTE_PATH} element={<ProjectMainView />} />
          <Route
            path={PROJECT_SETTINGS_ROUTE_PATH}
            element={<ProjectSettingsView />}
          />
          <Route
            path={PROJECT_ARCHIVED_ROUTE_PATH}
            element={<ProjectArchivedThreadsView />}
          />
          <Route
            path={THREAD_DETAIL_ROUTE_PATH}
            element={<ThreadDetailRoute />}
          />
          <Route
            path="*"
            element={<Navigate to={APP_ROOT_ROUTE_PATH} replace />}
          />
        </Routes>
      </Suspense>
    </AppLayout>
  );
}

export function App() {
  // Connect WebSocket for real-time invalidation
  useWebSocket();

  return (
    <QuickCreateProjectProvider>
      <NewManagerDialogProvider>
        <Routes>
          <Route
            path={AUTH_CALLBACK_ROUTE_PATH}
            element={<AuthCallbackView />}
          />
          <Route path="*" element={<AppRoutes />} />
        </Routes>
      </NewManagerDialogProvider>
    </QuickCreateProjectProvider>
  );
}
