import { useMemo, useState } from "react";
import type { Folder, Label, Preset } from "../../shared/contract.js";
import {
  listAllTasks,
  useFolders,
  usePresets,
  useProjects,
  useTasksQuery,
  useTasksRpc,
} from "../../shell/data.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bb/shared-ui/tabs";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import {
  PERMISSION_LABELS,
  PERMISSION_MODES,
  PresetDialog,
  describeError,
  describePresetEnvironment,
  savePresetDraft,
  type PresetDraft,
} from "./preset-dialog.js";
import { ColorSwatchPicker, DEFAULT_COLOR } from "./shared.js";

function LabelEditorRow({
  initialName,
  initialColor,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialColor: string;
  submitLabel: string;
  onSubmit: (name: string, color: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={name}
        placeholder="Label name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim() !== "") {
            event.preventDefault();
            void onSubmit(name.trim(), color).then(() => {
              if (!onCancel) {
                setName("");
                setColor(DEFAULT_COLOR);
              }
            });
          }
        }}
        className="h-7 w-44 text-xs"
      />
      <ColorSwatchPicker value={color} onChange={setColor} />
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={name.trim() === ""}
        onClick={() =>
          void onSubmit(name.trim(), color).then(() => {
            if (!onCancel) {
              setName("");
              setColor(DEFAULT_COLOR);
            }
          })
        }
      >
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function LabelsSection() {
  const rpc = useTasksRpc();
  const projects = useProjects();
  const projectList = projects.data ?? [];
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const projectId = selectedProjectId ?? projectList[0]?.id ?? null;
  const labels = useTasksQuery(
    async (rpc) =>
      projectId
        ? (await rpc.call("listLabels", { projectId })).labels
        : ([] as Label[]),
    ["projects:changed"],
    [projectId],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    label: Label;
    usedBy: number;
  } | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  const askDelete = (label: Label) =>
    run(async () => {
      const tasks = await listAllTasks(rpc, { labelIds: [label.id] });
      setConfirmDelete({ label, usedBy: tasks.length });
    });

  if (projectList.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Create a project first — labels are project-scoped.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Select
        value={projectId ?? undefined}
        onValueChange={(value) => {
          setSelectedProjectId(value);
          setEditingId(null);
        }}
      >
        <SelectTrigger aria-label="Project" className="h-8 w-56">
          <SelectValue placeholder="Project" />
        </SelectTrigger>
        <SelectContent>
          {projectList.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 rounded-sm"
                  style={{ backgroundColor: project.color }}
                />
                {project.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="divide-y divide-border-hairline rounded-md border border-border">
        {(labels.data ?? []).map((label) => (
          <div key={label.id} className="px-3 py-2">
            {editingId === label.id ? (
              <LabelEditorRow
                initialName={label.name}
                initialColor={label.color}
                submitLabel="Save"
                onCancel={() => setEditingId(null)}
                onSubmit={(name, color) =>
                  run(async () => {
                    await rpc.call("updateLabel", {
                      labelId: label.id,
                      name,
                      color,
                    });
                    setEditingId(null);
                  })
                }
              />
            ) : (
              <div className="group flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                <span className="flex-1 text-sm">{label.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100"
                  aria-label={`Edit label ${label.name}`}
                  onClick={() => setEditingId(label.id)}
                >
                  <Icon name="Edit" className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  aria-label={`Delete label ${label.name}`}
                  onClick={() => void askDelete(label)}
                >
                  <Icon name="Trash2" className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
        {(labels.data ?? []).length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No labels yet.
          </p>
        ) : null}
      </div>
      <LabelEditorRow
        initialName=""
        initialColor={DEFAULT_COLOR}
        submitLabel="Add label"
        onSubmit={(name, color) =>
          run(async () => {
            if (!projectId) return;
            await rpc.call("createLabel", { projectId, name, color });
          })
        }
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={`Delete label “${confirmDelete?.label.name ?? ""}”?`}
        description={
          confirmDelete && confirmDelete.usedBy > 0
            ? `Used by ${confirmDelete.usedBy} task${confirmDelete.usedBy > 1 ? "s" : ""} — removing it detaches them.`
            : "This label isn't used by any tasks."
        }
        confirmLabel="Delete label"
        onConfirm={() => {
          const target = confirmDelete;
          if (target) {
            void run(() =>
              rpc.call("deleteLabel", { labelId: target.label.id }),
            );
          }
        }}
      />
    </div>
  );
}

function PresetsSection() {
  const rpc = useTasksRpc();
  const presets = usePresets();
  const machines = useTasksQuery(
    async (rpc) => (await rpc.call("listMachines", {})).machines,
    [],
  );
  const [dialog, setDialog] = useState<{
    key: number;
    editing: Preset | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (editing: Preset | null, draft: PresetDraft) => {
    await savePresetDraft(rpc, editing, draft);
    presets.refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Presets available when dispatching a task to an agent.
        </p>
        <Button
          size="sm"
          className="h-7"
          onClick={() => setDialog({ key: Date.now(), editing: null })}
        >
          <Icon name="Plus" className="size-3.5" />
          New preset
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-hairline text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Provider</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Reasoning</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Permissions</th>
              <th className="px-3 py-2 font-medium">Environment</th>
              <th className="px-3 py-2 font-medium">Instructions</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-hairline">
            {(presets.data ?? []).map((preset) => {
              const permission = PERMISSION_MODES.find(
                (mode) => mode === preset.permissionMode,
              );
              return (
                <tr key={preset.id} className="group">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <Icon
                        name="Brain"
                        className="size-3.5 text-muted-foreground"
                      />
                      {preset.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {preset.providerId}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {preset.modelId}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {preset.reasoningLevel}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {preset.serviceTier ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {permission
                      ? PERMISSION_LABELS[permission]
                      : preset.permissionMode}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {describePresetEnvironment(preset, machines.data ?? [])}
                  </td>
                  <td
                    className="max-w-48 truncate px-3 py-2 text-xs text-muted-foreground"
                    title={preset.instructions}
                  >
                    {preset.instructions === "" ? "—" : preset.instructions}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 text-muted-foreground"
                        aria-label={`Edit preset ${preset.name}`}
                        onClick={() =>
                          setDialog({ key: Date.now(), editing: preset })
                        }
                      >
                        <Icon name="Edit" className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete preset ${preset.name}`}
                        onClick={() => {
                          setError(null);
                          rpc
                            .call("deletePreset", { presetId: preset.id })
                            .then(() => presets.refresh())
                            .catch((deleteError: unknown) =>
                              setError(describeError(deleteError)),
                            );
                        }}
                      >
                        <Icon name="Trash2" className="size-3.5" />
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {(presets.data ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-3 text-sm text-muted-foreground"
                >
                  No presets yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {dialog ? (
        <PresetDialog
          key={dialog.key}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          editing={dialog.editing}
          onSave={(draft) => save(dialog.editing, draft)}
        />
      ) : null}
    </div>
  );
}

const ROOT_PARENT = "__root__";

function FolderRow({
  folder,
  rootFolders,
  onRename,
  onMove,
  onDelete,
}: {
  folder: Folder;
  rootFolders: Folder[];
  onRename: (name: string) => Promise<void>;
  onMove: (parentFolderId: string | null) => Promise<void>;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(folder.name);
  const parentOptions = rootFolders.filter((entry) => entry.id !== folder.id);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
      {renaming ? (
        <>
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draftName.trim() !== "") {
                event.preventDefault();
                void onRename(draftName.trim()).then(() => setRenaming(false));
              }
              if (event.key === "Escape") setRenaming(false);
            }}
            className="h-7 w-44 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={draftName.trim() === ""}
            onClick={() =>
              void onRename(draftName.trim()).then(() => setRenaming(false))
            }
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => setRenaming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 truncate text-sm">{folder.name}</span>
          <Select
            value={folder.parentFolderId ?? ROOT_PARENT}
            onValueChange={(value) =>
              void onMove(value === ROOT_PARENT ? null : value)
            }
          >
            <SelectTrigger
              aria-label={`Parent of ${folder.name}`}
              className="h-7 w-40 text-xs text-muted-foreground"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT_PARENT}>Top level</SelectItem>
              {parentOptions.map((parent) => (
                <SelectItem key={parent.id} value={parent.id}>
                  {parent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground"
            aria-label={`Rename folder ${folder.name}`}
            onClick={() => {
              setDraftName(folder.name);
              setRenaming(true);
            }}
          >
            <Icon name="Edit" className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-destructive"
            aria-label={`Delete folder ${folder.name}`}
            onClick={onDelete}
          >
            <Icon name="Trash2" className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

function FoldersSection() {
  const rpc = useTasksRpc();
  const folders = useFolders();
  const projects = useProjects();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Folder | null>(null);
  const folderList = folders.data ?? [];
  const rootFolders = useMemo(
    () => folderList.filter((folder) => folder.parentFolderId === null),
    [folderList],
  );

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  const impactError = folders.error ?? projects.error;
  const impactReady =
    impactError === null &&
    folders.data !== undefined &&
    !folders.isLoading &&
    projects.data !== undefined &&
    !projects.isLoading;

  function describeDeleteImpact(folder: Folder): string {
    if (!impactReady) {
      return impactError !== null
        ? `Could not load the folder's contents: ${impactError}`
        : "Checking what the folder contains…";
    }
    const projectCount = (projects.data ?? []).filter(
      (project) => project.folderId === folder.id,
    ).length;
    const subfolderCount = folderList.filter(
      (entry) => entry.parentFolderId === folder.id,
    ).length;
    const moved = [
      projectCount > 0
        ? `${projectCount} project${projectCount > 1 ? "s" : ""}`
        : null,
      subfolderCount > 0
        ? `${subfolderCount} subfolder${subfolderCount > 1 ? "s" : ""}`
        : null,
    ].filter((part) => part !== null);
    return moved.length === 0
      ? "The folder is empty."
      : `${moved.join(" and ")} move to the top level. No tasks are deleted.`;
  }

  return (
    <div className="space-y-3">
      {folderList.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folders yet — create one from the New project dialog.
        </p>
      ) : (
        <div className="divide-y divide-border-hairline rounded-md border border-border">
          {folderList.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              rootFolders={rootFolders}
              onRename={(name) =>
                run(() =>
                  rpc.call("renameFolder", { folderId: folder.id, name }),
                )
              }
              onMove={(parentFolderId) =>
                run(() =>
                  rpc.call("moveFolder", {
                    folderId: folder.id,
                    parentFolderId,
                  }),
                )
              }
              onDelete={() => {
                setError(null);
                setConfirmDelete(folder);
              }}
            />
          ))}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={`Delete folder “${confirmDelete?.name ?? ""}”?`}
        description={confirmDelete ? describeDeleteImpact(confirmDelete) : ""}
        confirmLabel="Delete folder"
        confirmDisabled={!impactReady}
        onConfirm={() => {
          const target = confirmDelete;
          if (target) {
            void run(async () => {
              const result = await rpc.call("deleteFolder", {
                folderId: target.id,
              });
              if (!result.deleted) {
                folders.refresh();
                projects.refresh();
                throw new Error(`Folder “${target.name}” was already deleted.`);
              }
            });
          }
        }}
      />
    </div>
  );
}

export function ManagePanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4",
        className,
      )}
    >
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Manage</h2>
        <p className="text-sm text-muted-foreground">
          Labels, agent presets, and folders.
        </p>
      </header>
      <Tabs defaultValue="labels">
        <TabsList>
          <TabsTrigger value="labels">Labels</TabsTrigger>
          <TabsTrigger value="presets">Presets</TabsTrigger>
          <TabsTrigger value="folders">Folders</TabsTrigger>
        </TabsList>
        <TabsContent value="labels" className="pt-3">
          <LabelsSection />
        </TabsContent>
        <TabsContent value="presets" className="pt-3">
          <PresetsSection />
        </TabsContent>
        <TabsContent value="folders" className="pt-3">
          <FoldersSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
