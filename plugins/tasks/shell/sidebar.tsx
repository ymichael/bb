import { useMemo, useState, type ReactNode } from "react";
import type {
  Folder,
  Preset,
  Project,
  SidebarProjectSummary,
  Task,
} from "../shared/contract.js";
import { useTasksRpc } from "./data.js";
import type { TasksRoute } from "./routes.js";
import {
  PresetDialog,
  savePresetDraft,
} from "../views/manage/preset-dialog.js";
import { Icon } from "@bb/shared-ui/icon";
import { DelayedLoading } from "@bb/shared-ui/delayed-loading";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";

interface SidebarRowProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
}

function SidebarRow({ active, onClick, children, title }: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-9",
        onClick ? "cursor-pointer" : "cursor-default",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground",
        onClick && !active && "hover:bg-state-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SectionHeader({
  label,
  collapsed,
  onToggle,
}: {
  label: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {onToggle ? (
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3 transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      ) : null}
      {label}
    </>
  );
  if (onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="mt-3.5 flex w-full items-center gap-1 rounded-md px-2 pb-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
        aria-expanded={!collapsed}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="mt-3.5 flex items-center gap-1 px-2 pb-1 text-xs font-semibold text-muted-foreground">
      {content}
    </div>
  );
}

function ProjectDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: color }}
    />
  );
}

function WorkingDot() {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
    />
  );
}

function RowCount({ value }: { value: number }) {
  return (
    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
      {value}
    </span>
  );
}

function ProjectRow({
  project,
  summary,
  active,
  onClick,
}: {
  project: Project;
  summary: SidebarProjectSummary | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarRow active={active} onClick={onClick} title={project.name}>
      <ProjectDot color={project.color} />
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {summary && summary.activeAgentCount > 0 ? <WorkingDot /> : null}
      {summary ? <RowCount value={summary.taskCount} /> : null}
    </SidebarRow>
  );
}

function SidebarSkeleton() {
  return (
    <DelayedLoading>
      <div className="space-y-2 px-2 pt-2">
        {["w-3/4", "w-2/3", "w-4/5", "w-3/5", "w-2/3"].map((width, index) => (
          <div className="flex h-7 items-center gap-2 px-2" key={index}>
            <Skeleton className="size-3 rounded-sm" />
            <Skeleton className={cn("h-3", width)} />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

interface TasksSidebarProps {
  route: TasksRoute;
  folders: Folder[] | undefined;
  projects: Project[] | undefined;
  summaries: SidebarProjectSummary[] | undefined;
  presets: Preset[] | undefined;
  activeTasks: Task[] | undefined;
  isLoading: boolean;
  onNavigate: (route: TasksRoute) => void;
  onNewProject: () => void;
}

export function TasksSidebar({
  route,
  folders,
  projects,
  summaries,
  presets,
  activeTasks,
  isLoading,
  onNavigate,
  onNewProject,
}: TasksSidebarProps) {
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const rpc = useTasksRpc();
  const [presetDialog, setPresetDialog] = useState<{
    key: number;
    editing: Preset | null;
  } | null>(null);
  const summaryByProject = useMemo(
    () => new Map((summaries ?? []).map((entry) => [entry.projectId, entry])),
    [summaries],
  );
  const totalTasks = useMemo(
    () => (summaries ?? []).reduce((sum, entry) => sum + entry.taskCount, 0),
    [summaries],
  );
  const activeProjectId = route.kind === "project" ? route.projectId : null;
  const openProject = (projectId: string) =>
    onNavigate({ kind: "project", projectId, view: null });
  const toggleFolder = (folderId: string) =>
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });

  const rootFolders = (folders ?? []).filter((f) => f.parentFolderId === null);
  const childFolders = (folders ?? []).filter((f) => f.parentFolderId !== null);
  const knownFolderIds = new Set((folders ?? []).map((f) => f.id));
  const ungrouped = (projects ?? []).filter(
    (p) => p.folderId === null || !knownFolderIds.has(p.folderId),
  );

  const renderFolder = (folder: Folder, indent: boolean) => {
    const collapsed = collapsedFolders.has(folder.id);
    const folderProjects = (projects ?? []).filter(
      (p) => p.folderId === folder.id,
    );
    const children = childFolders.filter((f) => f.parentFolderId === folder.id);
    return (
      <div key={folder.id} className={cn(indent && "pl-3")}>
        <SectionHeader
          label={folder.name}
          collapsed={collapsed}
          onToggle={() => toggleFolder(folder.id)}
        />
        {!collapsed ? (
          <div className="space-y-px">
            {folderProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                summary={summaryByProject.get(project.id)}
                active={activeProjectId === project.id}
                onClick={() => openProject(project.id)}
              />
            ))}
            {}
            {!indent
              ? children.map((child) => renderFolder(child, true))
              : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
        <div className="space-y-px">
          <SidebarRow
            active={route.kind === "all"}
            onClick={() => onNavigate({ kind: "all" })}
          >
            <Icon name="ListView" className="size-3.5 shrink-0" />
            <span className="flex-1">All tasks</span>
            {summaries ? <RowCount value={totalTasks} /> : null}
          </SidebarRow>
          <SidebarRow
            active={route.kind === "active"}
            onClick={() => onNavigate({ kind: "active" })}
          >
            <Icon name="Zap" className="size-3.5 shrink-0" />
            <span className="flex-1">Active</span>
            {activeTasks && activeTasks.length > 0 ? <WorkingDot /> : null}
            {activeTasks ? <RowCount value={activeTasks.length} /> : null}
          </SidebarRow>
        </div>
        {isLoading ? (
          <SidebarSkeleton />
        ) : (
          <>
            {ungrouped.length > 0 ? (
              <>
                <SectionHeader label="Projects" />
                <div className="space-y-px">
                  {ungrouped.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      summary={summaryByProject.get(project.id)}
                      active={activeProjectId === project.id}
                      onClick={() => openProject(project.id)}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {rootFolders.map((folder) => renderFolder(folder, false))}
            {}
            {(projects ?? []).length > 0 ? (
              <div className="mt-1.5">
                <SidebarRow onClick={onNewProject} title="New project">
                  <Icon name="Plus" className="size-3.5 shrink-0" />
                  <span className="flex-1">New project</span>
                </SidebarRow>
              </div>
            ) : null}
            {presets ? (
              <>
                <SectionHeader label="Agent presets" />
                <div className="space-y-px">
                  {presets.map((preset) => (
                    <SidebarRow
                      key={preset.id}
                      title={`Edit preset ${preset.name}`}
                      onClick={() =>
                        setPresetDialog({ key: Date.now(), editing: preset })
                      }
                    >
                      <Icon name="Brain" className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {preset.name}
                      </span>
                      {preset.environmentKind === "new-worktree" ? (
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                aria-label="Spawns a new worktree"
                                className="flex shrink-0 text-muted-foreground/70"
                              >
                                <Icon name="GitBranch" className="size-3" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              Spawns a new worktree
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : null}
                    </SidebarRow>
                  ))}
                  {presets.length === 0 ? (
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      No presets yet.
                    </div>
                  ) : null}
                  <SidebarRow
                    title="New preset"
                    onClick={() =>
                      setPresetDialog({ key: Date.now(), editing: null })
                    }
                  >
                    <Icon name="Plus" className="size-3.5 shrink-0" />
                    <span className="flex-1">New preset</span>
                  </SidebarRow>
                </div>
              </>
            ) : null}
          </>
        )}
      </nav>
      <div className="shrink-0 border-t border-border-hairline px-2 py-1.5">
        <SidebarRow
          active={route.kind === "manage"}
          onClick={() => onNavigate({ kind: "manage" })}
        >
          <Icon name="Settings" className="size-3.5 shrink-0" />
          <span className="flex-1">Manage</span>
        </SidebarRow>
      </div>
      {presetDialog ? (
        <PresetDialog
          key={presetDialog.key}
          open
          onOpenChange={(open) => {
            if (!open) setPresetDialog(null);
          }}
          editing={presetDialog.editing}
          onSave={(draft) => savePresetDraft(rpc, presetDialog.editing, draft)}
        />
      ) : null}
    </div>
  );
}
