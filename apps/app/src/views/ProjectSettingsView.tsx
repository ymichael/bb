import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import "@bb/shared-ui/icon-extended";
import {
  findLocalPathProjectSourceForHost,
  type Host,
  type LocalPathProjectSource,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { PageShell } from "@/components/ui/page-shell.js";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import {
  ProjectMachineSetupDialog,
  type ProjectMachineSetupDialogTarget,
} from "@/components/dialogs/ProjectMachineSetupDialog";
import {
  ProjectSourceDeleteDialog,
  type ProjectSourceDeleteDialogTarget,
} from "@/components/dialogs/ProjectSourceDeleteDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section.js";
import { ProjectSourceRow } from "@/views/project-settings/ProjectSourceRow";
import {
  useAddLocalProjectSource,
  useDeleteLocalProjectSource,
  useUpdateLocalProjectSource,
} from "@/hooks/mutations/project-mutations";
import {
  isHostPathMissing,
  useHostPathExistence,
} from "@/hooks/queries/host-path-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import {
  useLocalPathPicker,
  type LocalPathSubmitParams,
} from "@/hooks/useLocalPathPicker";
import { stripProjectThreads } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";

export function ProjectSettingsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const sidebarNavigationQuery = useSidebarNavigation();
  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );
  const isLoading = sidebarNavigationQuery.isFetching && projects === undefined;

  const [deleteTarget, setDeleteTarget] =
    useState<ProjectSourceDeleteDialogTarget | null>(null);
  const [machineSetupTarget, setMachineSetupTarget] =
    useState<ProjectMachineSetupDialogTarget | null>(null);

  const hostsQuery = useHosts();
  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);

  const deleteSource = useDeleteLocalProjectSource();
  const addLocalSource = useAddLocalProjectSource();
  const updateLocalSource = useUpdateLocalProjectSource();

  const project = projects?.find((p) => p.id === projectId);
  const projectSources = project?.sources;
  const sources = useMemo(() => projectSources ?? [], [projectSources]);

  const projectName = project?.name ?? "";
  const localSourcePickerPending =
    addLocalSource.isPending || updateLocalSource.isPending;
  const localSourceSubmit = useCallback(
    ({ path, hostId, target, closeDialog }: LocalPathSubmitParams) => {
      if (!projectId) return;
      if (target.kind === "add-source") {
        addLocalSource.mutate(
          { projectId, path, hostId },
          { onSuccess: closeDialog },
        );
      } else if (target.kind === "update") {
        const source = sources.find((candidate) => candidate.hostId === hostId);
        if (!source) return;
        updateLocalSource.mutate(
          { projectId, sourceId: source.id, path },
          { onSuccess: closeDialog },
        );
      }
    },
    [addLocalSource, projectId, sources, updateLocalSource],
  );
  const localSourcePicker = useLocalPathPicker({
    isPending: localSourcePickerPending,
    submit: localSourceSubmit,
  });
  const openAddLocalSourcePicker = useCallback(() => {
    if (!projectId) return;
    localSourcePicker.openPicker({
      kind: "add-source",
      projectId,
      projectName,
    });
  }, [localSourcePicker, projectId, projectName]);
  const openEditLocalSourcePicker = useCallback(
    (source: LocalPathProjectSource) => {
      if (!projectId) return;
      localSourcePicker.openPicker({
        kind: "update",
        projectId,
        projectName,
        currentPath: source.path,
      });
    },
    [localSourcePicker, projectId, projectName],
  );
  const pickerHostId = localSourcePicker.hostId;

  const pickerHostSourcePaths = useMemo(() => {
    if (!pickerHostId) return [];
    return sources
      .filter((source) => source.hostId === pickerHostId)
      .map((source) => source.path);
  }, [pickerHostId, sources]);
  const pathExistence = useHostPathExistence(
    pickerHostId,
    pickerHostSourcePaths,
  );

  const projectGitRemoteUrl = project?.gitRemoteUrl ?? null;
  const openMachineSetup = useCallback(
    (host: Host) => {
      if (!projectId) return;
      setMachineSetupTarget({
        projectId,
        projectName,
        gitRemoteUrl: projectGitRemoteUrl,
        hostId: host.id,
        hostName: host.name,
      });
    },
    [projectGitRemoteUrl, projectId, projectName],
  );

  const hostById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );
  const multipleMachines = hosts.length > 1;
  const showAddLocalSourceButton =
    !multipleMachines &&
    pickerHostId != null &&
    !findLocalPathProjectSourceForHost(sources, pickerHostId);

  const addSourceButtons = multipleMachines ? (
    <div className="mt-2 flex gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={addLocalSource.isPending}
          >
            Add on a machine
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {hosts.map((host) => {
            const hasSource = Boolean(
              findLocalPathProjectSourceForHost(sources, host.id),
            );
            const connected = host.status === "connected";
            return (
              <DropdownMenuItem
                key={host.id}
                disabled={hasSource || !connected}
                onSelect={() => {
                  if (host.id === pickerHostId) {
                    openAddLocalSourcePicker();
                  } else {
                    openMachineSetup(host);
                  }
                }}
              >
                <MachineStatusDot connected={connected} />
                <span className="min-w-0 flex-1 truncate">{host.name}</span>
                {hasSource ? (
                  <span className="shrink-0 text-xs text-subtle-foreground">
                    Already added
                  </span>
                ) : !connected ? (
                  <span className="shrink-0 text-xs text-subtle-foreground">
                    Offline
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : showAddLocalSourceButton ? (
    <div className="mt-2 flex gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={addLocalSource.isPending}
        onClick={openAddLocalSourcePicker}
      >
        Add local path
      </Button>
    </div>
  ) : null;

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <SettingsSection title="Project Sources">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sources.length === 0 ? (
            <div>
              <p className="text-sm text-muted-foreground">
                No sources configured.
              </p>
              {addSourceButtons}
            </div>
          ) : (
            <div>
              <SettingsRowList>
                {sources.map((source) => {
                  const isPickerHostSource =
                    pickerHostId != null && source.hostId === pickerHostId;
                  const isInvalid =
                    isPickerHostSource &&
                    isHostPathMissing(pathExistence, source.path);
                  const machineHost = multipleMachines
                    ? hostById.get(source.hostId)
                    : undefined;
                  return (
                    <ProjectSourceRow
                      key={source.id}
                      source={source}
                      machine={
                        machineHost
                          ? {
                              name: machineHost.name,
                              connected: machineHost.status === "connected",
                            }
                          : null
                      }
                      canEditLocalPath={isPickerHostSource}
                      isLocalPathInvalid={isInvalid}
                      isEditPending={localSourcePickerPending}
                      isOnlySource={sources.length <= 1}
                      onEditLocalPath={openEditLocalSourcePicker}
                      onRemove={(target) =>
                        setDeleteTarget({
                          id: target.id,
                          label: target.path,
                        })
                      }
                    />
                  );
                })}
              </SettingsRowList>
              {addSourceButtons}
            </div>
          )}
        </SettingsSection>
      </div>

      <ProjectPathDialog
        target={localSourcePicker.projectPathDialog.target}
        pending={localSourcePickerPending}
        platform={localSourcePicker.platform}
        hostId={localSourcePicker.hostId}
        hostName={localSourcePicker.hostName}
        onOpenChange={localSourcePicker.projectPathDialog.onOpenChange}
        onSubmit={localSourcePicker.submitProjectPath}
      />

      <ProjectMachineSetupDialog
        target={machineSetupTarget}
        onOpenChange={(open) => {
          if (!open) setMachineSetupTarget(null);
        }}
        onComplete={() => setMachineSetupTarget(null)}
      />

      <ProjectSourceDeleteDialog
        target={deleteTarget}
        pending={deleteSource.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDelete={(sourceId) => {
          if (!projectId) return;
          deleteSource.mutate(
            { projectId, sourceId },
            { onSuccess: () => setDeleteTarget(null) },
          );
        }}
      />
    </PageShell>
  );
}
