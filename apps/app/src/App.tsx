import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { MainView } from "./views/MainView";
import { ProjectMainView } from "./views/ProjectMainView";
import { ProjectArchivedThreadsView } from "./views/ProjectArchivedThreadsView";
import { AppSettingsView } from "./views/AppSettingsView";
import { ProjectSettingsView } from "./views/ProjectSettingsView";
import { ThreadDetailView } from "./views/ThreadDetailView";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { useWebSocket } from "./hooks/useWebSocket";

export function App() {
  // Connect WebSocket for real-time invalidation
  useWebSocket();

  return (
    <QuickCreateProjectProvider>
      <AppLayout>
        <Routes>
          <Route path="/" element={<MainView />} />
          <Route path="/settings" element={<AppSettingsView />} />
          <Route path="/projects/:projectId" element={<ProjectMainView />} />
          <Route
            path="/projects/:projectId/settings"
            element={<ProjectSettingsView />}
          />
          <Route
            path="/projects/:projectId/archived"
            element={<ProjectArchivedThreadsView />}
          />
          <Route
            path="/projects/:projectId/threads/:threadId"
            element={<ThreadDetailView />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppLayout>
    </QuickCreateProjectProvider>
  );
}
