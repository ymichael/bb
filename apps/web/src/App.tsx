import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { MainView } from "./views/MainView";
import { ProjectMainView } from "./views/ProjectMainView";
import { ThreadDetailView } from "./views/ThreadDetailView";
import { TaskDetailView } from "./views/TaskDetailView";
import { RoleDetailView } from "./views/RoleDetailView";
import { useWebSocket } from "./hooks/useWebSocket";

export function App() {
  // Connect WebSocket for real-time invalidation
  useWebSocket();

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<MainView />} />
        <Route path="/projects/:projectId" element={<ProjectMainView />} />
        <Route
          path="/projects/:projectId/threads/:threadId"
          element={<ThreadDetailView />}
        />
        <Route
          path="/projects/:projectId/tasks/:taskId"
          element={<TaskDetailView />}
        />
        <Route path="/roles/:roleId" element={<RoleDetailView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}
