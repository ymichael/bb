import { useEffect, useMemo, useState } from "react";
import {
  useFolders,
  useProjects,
  useTasksQuery,
  useTasksRpc,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import {
  ColorSwatchPicker,
  DEFAULT_COLOR,
  describeCreateProjectError,
  derivePrefix,
  Field,
  PROJECT_PREFIX_PATTERN,
} from "./shared.js";
import {
  BbProjectLinkPicker,
  emptyBbProjectLinkState,
  resolveBbProjectLink,
  type BbProjectLinkState,
} from "./bb-project-link.js";

const NO_FOLDER = "__none__";
const NEW_FOLDER = "__new__";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({
  open,
  onOpenChange,
}: NewProjectDialogProps) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const projects = useProjects();
  const folders = useFolders();

  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [linkState, setLinkState] = useState<BbProjectLinkState>(
    emptyBbProjectLinkState,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bbProjects = useTasksQuery(
    async (rpc) => (await rpc.call("listBbProjects")).bbProjects,
    [],
  );
  const bbProjectList = bbProjects.data ?? [];

  useEffect(() => {
    if (!open) return;
    setName("");
    setPrefix("");
    setPrefixTouched(false);
    setColor(DEFAULT_COLOR);
    setFolderId(null);
    setNewFolderMode(false);
    setNewFolderName("");
    setLinkState(emptyBbProjectLinkState());
    setError(null);
  }, [open]);

  const prefixError = useMemo(() => {
    if (prefix === "") return null;
    if (!PROJECT_PREFIX_PATTERN.test(prefix)) {
      return "Use 1–10 uppercase letters and digits, starting with a letter.";
    }
    const clash = (projects.data ?? []).find(
      (project) => project.prefix.toUpperCase() === prefix.toUpperCase(),
    );
    return clash ? `Already used by ${clash.name}.` : null;
  }, [prefix, projects.data]);

  const linkedTrimmed = resolveBbProjectLink(linkState);

  const canSubmit =
    name.trim().length > 0 &&
    prefix.length > 0 &&
    prefixError === null &&
    !submitting;

  const folderList = folders.data ?? [];
  const folderName = (id: string) => {
    const folder = folderList.find((entry) => entry.id === id);
    if (!folder) return "Folder";
    const parent = folder.parentFolderId
      ? folderList.find((entry) => entry.id === folder.parentFolderId)
      : null;
    return parent ? `${parent.name} / ${folder.name}` : folder.name;
  };

  const createFolderInline = async () => {
    const trimmed = newFolderName.trim();
    if (trimmed === "") return;
    setError(null);
    try {
      const { folder } = await rpc.call("createFolder", {
        name: trimmed,
        parentFolderId: null,
      });
      setFolderId(folder.id);
      setNewFolderMode(false);
      setNewFolderName("");
    } catch (folderError) {
      setError(
        folderError instanceof Error
          ? folderError.message
          : String(folderError),
      );
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const { project } = await rpc.call("createProject", {
        name: name.trim(),
        prefix,
        color,
        folderId,
        linkedBbProjectId: linkedTrimmed === "" ? null : linkedTrimmed,
      });
      onOpenChange(false);
      navigation.go({ kind: "project", projectId: project.id, view: null });
    } catch (submitError) {
      setError(describeCreateProjectError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Projects group tasks under a shared key prefix.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              placeholder="e.g. Tasks Plugin"
              onChange={(event) => {
                setName(event.target.value);
                if (!prefixTouched) setPrefix(derivePrefix(event.target.value));
              }}
              className="h-8"
            />
          </Field>
          <Field
            label="Prefix"
            hint={
              prefixError ??
              "Task keys use this prefix, e.g. TSK-12. Uppercase, unique."
            }
          >
            <Input
              value={prefix}
              placeholder="TSK"
              aria-invalid={prefixError !== null}
              onChange={(event) => {
                setPrefixTouched(true);
                setPrefix(event.target.value.toUpperCase());
              }}
              className={
                prefixError !== null
                  ? "h-8 w-32 border-destructive focus-visible:ring-destructive"
                  : "h-8 w-32"
              }
            />
          </Field>
          <Field label="Color">
            <ColorSwatchPicker value={color} onChange={setColor} />
          </Field>
          <Field label="Folder">
            <Select
              value={newFolderMode ? NEW_FOLDER : (folderId ?? NO_FOLDER)}
              onValueChange={(value) => {
                if (value === NEW_FOLDER) {
                  setNewFolderMode(true);
                  return;
                }
                setNewFolderMode(false);
                setFolderId(value === NO_FOLDER ? null : value);
              }}
            >
              <SelectTrigger aria-label="Folder" className="h-8">
                <SelectValue>
                  {newFolderMode
                    ? "New folder…"
                    : folderId
                      ? folderName(folderId)
                      : "No folder"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FOLDER}>No folder</SelectItem>
                {folderList.map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folderName(folder.id)}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={NEW_FOLDER}>New folder…</SelectItem>
              </SelectContent>
            </Select>
            {newFolderMode ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <Input
                  autoFocus
                  value={newFolderName}
                  placeholder="Folder name"
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createFolderInline();
                    }
                  }}
                  className="h-7 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={newFolderName.trim() === ""}
                  onClick={() => void createFolderInline()}
                >
                  <Icon name="FolderPlus" className="size-3.5" />
                  Create
                </Button>
              </div>
            ) : null}
          </Field>
          <Field
            label="Linked bb project"
            hint="Optional. Linking a bb project enables dispatching to agents."
          >
            <BbProjectLinkPicker
              state={linkState}
              onStateChange={setLinkState}
              bbProjects={bbProjectList}
            />
          </Field>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
