import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import {
  useActiveTasks,
  useFolders,
  usePresets,
  useProjects,
  useSidebarSummary,
} from "./data.js";
import { TasksRefreshProvider } from "./refresh.js";
import { parseTasksRoute, useTasksNavigation } from "./routes.js";
import { TasksSidebar } from "./sidebar.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { useState } from "react";

function isAwaitingFirstResult(query: {
  data: unknown;
  error: string | null;
}): boolean {
  return query.data === undefined && query.error === null;
}

function TasksNavigationPanelContent({ subPath }: PluginNavPanelProps) {
  const route = parseTasksRoute(subPath);
  const navigation = useTasksNavigation();
  const folders = useFolders();
  const projects = useProjects();
  const summaries = useSidebarSummary();
  const presets = usePresets();
  const activeTasks = useActiveTasks();
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  return (
    <>
      <TasksSidebar
        route={route}
        folders={folders.data}
        projects={projects.data}
        summaries={summaries.data}
        presets={presets.data}
        activeTasks={activeTasks.data}
        isLoading={
          isAwaitingFirstResult(folders) ||
          isAwaitingFirstResult(projects) ||
          isAwaitingFirstResult(summaries)
        }
        onNavigate={navigation.go}
        onNewProject={() => setNewProjectOpen(true)}
      />
      {newProjectOpen ? (
        <NewProjectDialog open onOpenChange={setNewProjectOpen} />
      ) : null}
    </>
  );
}

export function TasksNavigationPanel(props: PluginNavPanelProps) {
  return (
    <TasksRefreshProvider>
      <TasksNavigationPanelContent {...props} />
    </TasksRefreshProvider>
  );
}
