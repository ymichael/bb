import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { AuthCallbackView } from "./views/AuthCallbackView";
import { MainView } from "./views/MainView";
import { ProjectMainView } from "./views/ProjectMainView";
import { NewManagerView } from "./views/NewManagerView";
import { ProjectArchivedThreadsView } from "./views/ProjectArchivedThreadsView";
import { AppSettingsView } from "./views/AppSettingsView";
import { ProjectSettingsView } from "./views/ProjectSettingsView";
import { ThreadDetailView } from "./views/thread-detail/ThreadDetailView";
import { InternalReplayListView } from "./views/InternalReplayListView";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { useWebSocket } from "./hooks/useWebSocket";
import {
  APP_ROOT_ROUTE_PATH,
  APP_SETTINGS_ROUTE_PATH,
  AUTH_CALLBACK_ROUTE_PATH,
  DEVELOPMENT_REPLAY_ROUTE_PATH,
  PROJECT_ARCHIVED_ROUTE_PATH,
  PROJECT_MAIN_ROUTE_PATH,
  PROJECT_NEW_MANAGER_ROUTE_PATH,
  PROJECT_SETTINGS_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
} from "./lib/app-route-paths";

function AppRoutes() {
  return (
    <AppLayout>
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
          path={PROJECT_NEW_MANAGER_ROUTE_PATH}
          element={<NewManagerView />}
        />
        <Route
          path={PROJECT_SETTINGS_ROUTE_PATH}
          element={<ProjectSettingsView />}
        />
        <Route
          path={PROJECT_ARCHIVED_ROUTE_PATH}
          element={<ProjectArchivedThreadsView />}
        />
        <Route path={THREAD_DETAIL_ROUTE_PATH} element={<ThreadDetailView />} />
        <Route
          path="*"
          element={<Navigate to={APP_ROOT_ROUTE_PATH} replace />}
        />
      </Routes>
    </AppLayout>
  );
}

export function App() {
  // Connect WebSocket for real-time invalidation
  useWebSocket();

  return (
    <QuickCreateProjectProvider>
      <Routes>
        <Route path={AUTH_CALLBACK_ROUTE_PATH} element={<AuthCallbackView />} />
        <Route path="*" element={<AppRoutes />} />
      </Routes>
    </QuickCreateProjectProvider>
  );
}
