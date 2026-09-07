import { createHash, randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { initializeTasksSchema } from "./schema";
import {
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
  type TaskSort,
} from "../shared/pagination.js";
import {
  presetPermissionModeSchema,
  presetReasoningLevelSchema,
  presetServiceTierSchema,
} from "../shared/contract.js";
import type {
  Attachment,
  Comment,
  CreateAttachmentInput,
  CreateCommentInput,
  CreateFolderInput,
  CreateLabelInput,
  CreatePresetInput,
  CreateProjectInput,
  CreateTaskInput,
  DeleteFolderResult,
  Folder,
  Label,
  ListTasksFilters,
  ListTasksPage,
  Preset,
  PresetEnvironmentKind,
  Project,
  SubtaskDoneCounts,
  Task,
  TaskLabel,
  TaskThread,
  TaskThreadLiveStatus,
  UpdateAttachmentInput,
  UpdateCommentInput,
  UpdateFolderInput,
  UpdateLabelInput,
  UpdatePresetInput,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateTaskPositionInput,
  UpsertTaskThreadInput,
} from "./types";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type SqlParameter = string | number;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const POSITION_STEP = 1_024;
const MIN_POSITION_GAP = 0.000_001;
const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

interface FolderRow {
  id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  prefix: string;
  next_task_number: number;
  color: string;
  folder_id: string | null;
  linked_bb_project_id: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  number: number;
  project_prefix: string;
  title: string;
  description: string;
  status: Task["status"];
  priority: Task["priority"];
  due_date: string | null;
  parent_task_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

interface TaskPageRow extends TaskRow {
  cursor_priority: number;
  cursor_due_null: number;
  cursor_due_date: string;
  cursor_project_id: string;
  cursor_status: string;
  cursor_position: number;
  cursor_id: string;
}

interface TaskListRevisionRow {
  revision: number;
}

interface LabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string;
}

interface TaskLabelRow {
  task_id: string;
  label_id: string;
}

interface CommentRow {
  id: string;
  task_id: string;
  kind: Comment["kind"];
  author_name: string;
  preset_name: string | null;
  thread_id: string | null;
  body: string;
  notified_count: number;
  created_at: string;
}

interface AttachmentRow {
  id: string;
  task_id: string | null;
  comment_id: string | null;
  file_name: string;
  mime: string;
  size_bytes: number;
  blob_path: string;
  is_image: number;
  created_at: string;
}

interface TaskThreadRow {
  id: string;
  task_id: string;
  thread_id: string;
  preset_name: string;
  title: string;
  live_status: TaskThreadLiveStatus;
  attached_at: string;
  updated_at: string;
}

interface PresetRow {
  id: string;
  name: string;
  provider_id: string;
  model_id: string;
  reasoning_level: string;
  service_tier: string | null;
  permission_mode: string;
  environment_kind: PresetEnvironmentKind;
  base_branch: string | null;
  machine_id: string | null;
  instructions: string;
  builtin: number;
  created_at: string;
}

const taskCursorSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    query: z.string().length(43),
    sort: z.enum(["manual", "priority", "due"]),
    key: z
      .object({
        priority: z.number().int().min(0).max(5),
        dueNull: z.number().int().min(0).max(1),
        dueDate: z.string(),
        projectId: z.string(),
        status: z.string(),
        position: z.number().finite(),
        id: z.string(),
      })
      .strict(),
  })
  .strict();

type TaskCursor = z.infer<typeof taskCursorSchema>;

export class TasksPageCursorError extends Error {
  constructor(
    readonly code: "invalid_cursor" | "cursor_query_mismatch" | "stale_cursor",
    message: string,
  ) {
    super(message);
    this.name = "TasksPageCursorError";
  }
}

function normalizedFilterValues(values: readonly string[] | undefined) {
  return values === undefined ? null : [...new Set(values)].sort();
}

function taskQueryFingerprint(
  filters: ListTasksFilters,
  sort: TaskSort,
): string {
  const normalized = JSON.stringify({
    projectId: filters.projectId ?? null,
    statuses: normalizedFilterValues(filters.statuses),
    priorities: normalizedFilterValues(filters.priorities),
    labelIds: normalizedFilterValues(filters.labelIds),
    activeOnly: filters.activeOnly === true,
    parentTaskId:
      filters.parentTaskId === undefined
        ? { specified: false, value: null }
        : { specified: true, value: filters.parentTaskId },
    search: filters.search?.trim() || null,
    sort,
  });
  return createHash("sha256").update(normalized).digest("base64url");
}

function decodeTaskCursor(value: string): TaskCursor {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    const result = taskCursorSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {}
  throw new TasksPageCursorError(
    "invalid_cursor",
    "invalid task-list cursor; start again without --cursor",
  );
}

function encodeTaskCursor(cursor: TaskCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

let lastUlidMs = -1;
let lastUlidRandom = 0n;

function createUlid(now = Date.now()): string {
  let random: bigint;
  if (now === lastUlidMs) {
    random = lastUlidRandom + 1n;
  } else {
    random = 0n;
    for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  }
  lastUlidMs = now;
  lastUlidRandom = random;
  let value = (BigInt(now) << 80n) | random;

  let id = "";
  for (let index = 0; index < 26; index += 1) {
    id = ULID_ALPHABET[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createOrValidateUlid(id: string | undefined): string {
  if (id === undefined) return createUlid();
  if (!ULID_PATTERN.test(id)) throw new Error(`Invalid ULID: ${id}`);
  return id;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty`);
  return trimmed;
}

function validatePrefix(prefix: string): string {
  if (!PROJECT_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      "Project prefix must be uppercase alphanumeric, start with a letter, and contain at most 10 characters",
    );
  }
  return prefix;
}

function validateDueDate(dueDate: string | null): string | null {
  if (dueDate === null) return null;
  if (!ISO_DATE_PATTERN.test(dueDate)) {
    throw new Error("dueDate must be an ISO date in YYYY-MM-DD format");
  }
  const parsed = new Date(`${dueDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== dueDate
  ) {
    throw new Error("dueDate must be a valid calendar date");
  }
  return dueDate;
}

function validateLinkedBbProjectId(id: string | null): string | null {
  if (id !== null && !id.startsWith("proj_")) {
    throw new Error("linkedBbProjectId must be a bb proj_* id");
  }
  return id;
}

function validateThreadId(id: string): string;
function validateThreadId(id: null): null;
function validateThreadId(id: string | null): string | null;
function validateThreadId(id: string | null): string | null {
  if (id !== null && !id.startsWith("thr_")) {
    throw new Error("threadId must be a bb thr_* id");
  }
  return id;
}

function validateBlobPath(blobPath: string): string {
  const path = requireNonEmpty(blobPath, "Attachment blobPath");
  const segments = path.split(/[\\/]/);
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    segments.includes("..")
  ) {
    throw new Error(
      "Attachment blobPath must be relative to the plugin data directory",
    );
  }
  return path;
}

function folderFromRow(row: FolderRow): Folder {
  return {
    id: row.id,
    name: row.name,
    parentFolderId: row.parent_folder_id,
    createdAt: row.created_at,
  };
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    nextTaskNumber: row.next_task_number,
    color: row.color,
    folderId: row.folder_id,
    linkedBbProjectId: row.linked_bb_project_id,
    createdAt: row.created_at,
  };
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    key: `${row.project_prefix}-${row.number}`,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    parentTaskId: row.parent_task_id,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function labelFromRow(row: LabelRow): Label {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    color: row.color,
  };
}

function taskLabelFromRow(row: TaskLabelRow): TaskLabel {
  return { taskId: row.task_id, labelId: row.label_id };
}

function commentFromRow(row: CommentRow): Comment {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    authorName: row.author_name,
    presetName: row.preset_name,
    threadId: row.thread_id,
    body: row.body,
    notifiedCount: row.notified_count,
    createdAt: row.created_at,
  };
}

function attachmentFromRow(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    fileName: row.file_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    blobPath: row.blob_path,
    isImage: row.is_image === 1,
    createdAt: row.created_at,
  };
}

function taskThreadFromRow(row: TaskThreadRow): TaskThread {
  return {
    id: row.id,
    taskId: row.task_id,
    threadId: row.thread_id,
    presetName: row.preset_name,
    title: row.title,
    liveStatus: row.live_status,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at,
  };
}

function presetFromRow(row: PresetRow): Preset {
  return {
    id: row.id,
    name: row.name,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoningLevel: presetReasoningLevelSchema.parse(row.reasoning_level),
    serviceTier:
      row.service_tier === null
        ? null
        : presetServiceTierSchema.parse(row.service_tier),
    permissionMode: presetPermissionModeSchema.parse(row.permission_mode),
    environmentKind: row.environment_kind,
    baseBranch: row.base_branch,
    machineId: row.machine_id,
    instructions: row.instructions,
    builtin: row.builtin === 1,
    createdAt: row.created_at,
  };
}

function validatePresetEnvironment(input: {
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  machineId: string | null;
}): {
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  machineId: string | null;
} {
  const baseBranch =
    input.baseBranch === null
      ? null
      : requireNonEmpty(input.baseBranch, "Preset baseBranch");
  const machineId =
    input.machineId === null
      ? null
      : requireNonEmpty(input.machineId, "Preset machineId");
  if (
    input.environmentKind === "project-default" &&
    (baseBranch !== null || machineId !== null)
  ) {
    throw new Error(
      "Preset baseBranch and machineId require environmentKind new-worktree",
    );
  }
  return { environmentKind: input.environmentKind, baseBranch, machineId };
}

export function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function createTasksStore(db: PluginDatabase) {
  initializeTasksSchema(db);

  const getFolderRow = db.prepare<[string], FolderRow>(
    "SELECT * FROM folders WHERE id = ?",
  );
  const getProjectRow = db.prepare<[string], ProjectRow>(
    "SELECT * FROM projects WHERE id = ?",
  );
  const taskSelect = `
    SELECT t.*, p.prefix AS project_prefix
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
  `;
  const getTaskRow = db.prepare<[string], TaskRow>(
    `${taskSelect} WHERE t.id = ?`,
  );
  const getLabelRow = db.prepare<[string], LabelRow>(
    "SELECT * FROM labels WHERE id = ?",
  );
  const getCommentRow = db.prepare<[string], CommentRow>(
    "SELECT * FROM comments WHERE id = ?",
  );
  const getAttachmentRow = db.prepare<[string], AttachmentRow>(
    "SELECT * FROM attachments WHERE id = ?",
  );
  const getTaskThreadRow = db.prepare<[string], TaskThreadRow>(
    "SELECT * FROM task_threads WHERE id = ?",
  );
  const getPresetRow = db.prepare<[string], PresetRow>(
    "SELECT * FROM presets WHERE id = ?",
  );

  function getFolder(id: string): Folder | undefined {
    const row = getFolderRow.get(id);
    return row ? folderFromRow(row) : undefined;
  }

  function requireFolder(id: string): Folder {
    const folder = getFolder(id);
    if (!folder) throw new Error(`Folder not found: ${id}`);
    return folder;
  }

  function validateFolderParent(folderId: string | null, ownId?: string): void {
    if (folderId === null) return;
    if (folderId === ownId) throw new Error("A folder cannot contain itself");
    const parent = requireFolder(folderId);
    if (parent.parentFolderId !== null) {
      throw new Error("Folders support at most one level of nesting");
    }
    if (ownId) {
      const hasChildren = db
        .prepare<[string], { found: number }>(
          "SELECT 1 AS found FROM folders WHERE parent_folder_id = ? LIMIT 1",
        )
        .get(ownId);
      if (hasChildren) {
        throw new Error("A folder with children cannot be nested");
      }
    }
  }

  function createFolder(input: CreateFolderInput): Folder {
    const id = createOrValidateUlid(input.id);
    const parentFolderId = input.parentFolderId ?? null;
    validateFolderParent(parentFolderId, id);
    db.prepare<[string, string, string | null, string]>(
      "INSERT INTO folders (id, name, parent_folder_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      id,
      requireNonEmpty(input.name, "Folder name"),
      parentFolderId,
      nowIso(),
    );
    return requireFolder(id);
  }

  function listFolders(): Folder[] {
    return db
      .prepare<[], FolderRow>(
        "SELECT * FROM folders ORDER BY parent_folder_id IS NOT NULL, name COLLATE NOCASE, id",
      )
      .all()
      .map(folderFromRow);
  }

  function updateFolder(id: string, input: UpdateFolderInput): Folder {
    const current = requireFolder(id);
    const parentFolderId =
      input.parentFolderId === undefined
        ? current.parentFolderId
        : input.parentFolderId;
    validateFolderParent(parentFolderId, id);
    db.prepare<[string, string | null, string]>(
      "UPDATE folders SET name = ?, parent_folder_id = ? WHERE id = ?",
    ).run(
      input.name === undefined
        ? current.name
        : requireNonEmpty(input.name, "Folder name"),
      parentFolderId,
      id,
    );
    return requireFolder(id);
  }

  const selectFolderProjectIds = db.prepare<[string], { id: string }>(
    "SELECT id FROM projects WHERE folder_id = ? ORDER BY name COLLATE NOCASE, id",
  );
  const selectChildFolderIds = db.prepare<[string], { id: string }>(
    "SELECT id FROM folders WHERE parent_folder_id = ? ORDER BY name COLLATE NOCASE, id",
  );
  const deleteFolderRow = db.prepare<[string]>(
    "DELETE FROM folders WHERE id = ?",
  );

  const deleteFolderTransaction = db.transaction(
    (id: string): DeleteFolderResult => {
      const movedProjectIds = selectFolderProjectIds
        .all(id)
        .map((row) => row.id);
      const movedFolderIds = selectChildFolderIds.all(id).map((row) => row.id);
      const deleted = deleteFolderRow.run(id).changes > 0;
      return deleted
        ? { deleted, movedProjectIds, movedFolderIds }
        : { deleted, movedProjectIds: [], movedFolderIds: [] };
    },
  );

  function deleteFolder(id: string): DeleteFolderResult {
    return deleteFolderTransaction(id);
  }

  function getProject(id: string): Project | undefined {
    const row = getProjectRow.get(id);
    return row ? projectFromRow(row) : undefined;
  }

  function requireProject(id: string): Project {
    const project = getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  }

  function createProject(input: CreateProjectInput): Project {
    const id = createOrValidateUlid(input.id);
    const folderId = input.folderId ?? null;
    if (folderId !== null) requireFolder(folderId);
    db.prepare<
      [string, string, string, string, string | null, string | null, string]
    >(
      `
      INSERT INTO projects
        (id, name, prefix, next_task_number, color, folder_id, linked_bb_project_id, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `,
    ).run(
      id,
      requireNonEmpty(input.name, "Project name"),
      validatePrefix(input.prefix),
      requireNonEmpty(input.color, "Project color"),
      folderId,
      validateLinkedBbProjectId(input.linkedBbProjectId ?? null),
      nowIso(),
    );
    return requireProject(id);
  }

  function listProjects(folderId?: string | null): Project[] {
    if (folderId === undefined) {
      return db
        .prepare<[], ProjectRow>(
          "SELECT * FROM projects ORDER BY name COLLATE NOCASE, id",
        )
        .all()
        .map(projectFromRow);
    }
    const rows =
      folderId === null
        ? db
            .prepare<[], ProjectRow>(
              "SELECT * FROM projects WHERE folder_id IS NULL ORDER BY name COLLATE NOCASE, id",
            )
            .all()
        : db
            .prepare<[string], ProjectRow>(
              "SELECT * FROM projects WHERE folder_id = ? ORDER BY name COLLATE NOCASE, id",
            )
            .all(folderId);
    return rows.map(projectFromRow);
  }

  function updateProject(id: string, input: UpdateProjectInput): Project {
    const current = requireProject(id);
    const folderId =
      input.folderId === undefined ? current.folderId : input.folderId;
    if (folderId !== null) requireFolder(folderId);
    db.prepare<[string, string, string, string | null, string | null, string]>(
      `
      UPDATE projects
      SET name = ?, prefix = ?, color = ?, folder_id = ?, linked_bb_project_id = ?
      WHERE id = ?
    `,
    ).run(
      input.name === undefined
        ? current.name
        : requireNonEmpty(input.name, "Project name"),
      input.prefix === undefined
        ? current.prefix
        : validatePrefix(input.prefix),
      input.color === undefined
        ? current.color
        : requireNonEmpty(input.color, "Project color"),
      folderId,
      input.linkedBbProjectId === undefined
        ? current.linkedBbProjectId
        : validateLinkedBbProjectId(input.linkedBbProjectId),
      id,
    );
    return requireProject(id);
  }

  function deleteProject(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM projects WHERE id = ?").run(id)
        .changes > 0
    );
  }

  function getTask(id: string): Task | undefined {
    const row = getTaskRow.get(id);
    return row ? taskFromRow(row) : undefined;
  }

  const getTaskByKeyRow = db.prepare<[string, number], TaskRow>(
    `${taskSelect} WHERE p.prefix = ? COLLATE NOCASE AND t.number = ?`,
  );

  function getTaskByKey(key: string): Task | undefined {
    const match = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(key.trim());
    if (!match) return undefined;
    const [, prefix, number] = match;
    if (prefix === undefined || number === undefined) return undefined;
    const row = getTaskByKeyRow.get(prefix, Number(number));
    return row ? taskFromRow(row) : undefined;
  }

  function requireTask(id: string): Task {
    const task = getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  function validateTaskParent(
    projectId: string,
    parentTaskId: string | null,
    ownId?: string,
  ): void {
    if (parentTaskId === null) return;
    if (parentTaskId === ownId)
      throw new Error("A task cannot be its own parent");
    const parent = requireTask(parentTaskId);
    if (parent.projectId !== projectId) {
      throw new Error(
        "A sub-task must belong to the same project as its parent",
      );
    }
    if (parent.parentTaskId !== null) {
      throw new Error("Tasks support at most one level of sub-tasks");
    }
    if (ownId) {
      const hasChildren = db
        .prepare<[string], { found: number }>(
          "SELECT 1 AS found FROM tasks WHERE parent_task_id = ? LIMIT 1",
        )
        .get(ownId);
      if (hasChildren) {
        throw new Error(
          "A task with sub-tasks cannot itself become a sub-task",
        );
      }
    }
  }

  const createTaskTransaction = db.transaction(
    (input: CreateTaskInput): Task => {
      const project = requireProject(input.projectId);
      const id = createOrValidateUlid(input.id);
      const status = input.status ?? "backlog";
      const parentTaskId = input.parentTaskId ?? null;
      validateTaskParent(project.id, parentTaskId, id);
      const position =
        db
          .prepare<[string, Task["status"]], { position: number }>(
            `
          SELECT COALESCE(MAX(position), 0) + ${POSITION_STEP} AS position
          FROM tasks WHERE project_id = ? AND status = ?
        `,
          )
          .get(project.id, status)?.position ?? POSITION_STEP;
      const createdAt = nowIso();

      const allocated = db
        .prepare<[string, number]>(
          `
        UPDATE projects
        SET next_task_number = next_task_number + 1
        WHERE id = ? AND next_task_number = ?
      `,
        )
        .run(project.id, project.nextTaskNumber);
      if (allocated.changes !== 1) {
        throw new Error(
          `Could not allocate the next task number for ${project.id}`,
        );
      }

      db.prepare<
        [
          string,
          string,
          number,
          string,
          string,
          Task["status"],
          Task["priority"],
          string | null,
          string | null,
          number,
          string,
          string,
        ]
      >(
        `
      INSERT INTO tasks (
        id, project_id, number, title, description, status, priority, due_date,
        parent_task_id, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      ).run(
        id,
        project.id,
        project.nextTaskNumber,
        requireNonEmpty(input.title, "Task title"),
        input.description ?? "",
        status,
        input.priority ?? "none",
        validateDueDate(input.dueDate ?? null),
        parentTaskId,
        position,
        createdAt,
        createdAt,
      );
      return requireTask(id);
    },
  );

  function createTask(input: CreateTaskInput): Task {
    return createTaskTransaction(input);
  }

  function listTasksPage(filters: ListTasksFilters = {}): ListTasksPage {
    const clauses: string[] = [];
    const parameters: Record<string, SqlParameter> = {};

    if (filters.projectId !== undefined) {
      clauses.push("t.project_id = @projectId");
      parameters.projectId = filters.projectId;
    }
    if (filters.statuses !== undefined) {
      if (filters.statuses.length === 0) {
        clauses.push("0 = 1");
      } else {
        const names = filters.statuses.map((status, index) => {
          const name = `status${index}`;
          parameters[name] = status;
          return `@${name}`;
        });
        clauses.push(`t.status IN (${names.join(", ")})`);
      }
    }
    if (filters.priorities !== undefined) {
      if (filters.priorities.length === 0) {
        clauses.push("0 = 1");
      } else {
        const names = filters.priorities.map((priority, index) => {
          const name = `priority${index}`;
          parameters[name] = priority;
          return `@${name}`;
        });
        clauses.push(`t.priority IN (${names.join(", ")})`);
      }
    }
    if (filters.labelIds !== undefined) {
      if (filters.labelIds.length === 0) {
        clauses.push("0 = 1");
      } else {
        const names = filters.labelIds.map((labelId, index) => {
          const name = `label${index}`;
          parameters[name] = labelId;
          return `@${name}`;
        });
        clauses.push(`EXISTS (
          SELECT 1 FROM task_labels tl
          WHERE tl.task_id = t.id AND tl.label_id IN (${names.join(", ")})
        )`);
      }
    }
    if (filters.activeOnly === true) {
      clauses.push(`EXISTS (
        SELECT 1 FROM task_threads tt
        WHERE tt.task_id = t.id AND tt.live_status IN ('starting', 'working')
      )`);
    }
    if (filters.parentTaskId !== undefined) {
      if (filters.parentTaskId === null) {
        clauses.push("t.parent_task_id IS NULL");
      } else {
        clauses.push("t.parent_task_id = @parentTaskId");
        parameters.parentTaskId = filters.parentTaskId;
      }
    }
    const search = filters.search?.trim();
    if (search) {
      parameters.search = `%${escapeLike(search)}%`;
      clauses.push(`(
        t.title LIKE @search ESCAPE '\\'
        OR t.description LIKE @search ESCAPE '\\'
        OR (p.prefix || '-' || t.number) LIKE @search ESCAPE '\\'
      )`);
    }

    const limit = filters.limit ?? TASKS_PAGE_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > TASKS_PAGE_MAX_LIMIT) {
      throw new Error(
        `Task page limit must be an integer from 1 to ${TASKS_PAGE_MAX_LIMIT}`,
      );
    }
    const sort = filters.sort ?? "manual";
    const query = taskQueryFingerprint(filters, sort);
    const cursor =
      filters.cursor === undefined ? null : decodeTaskCursor(filters.cursor);
    if (cursor !== null && cursor.sort !== sort) {
      throw new TasksPageCursorError(
        "cursor_query_mismatch",
        "task-list cursor does not match --sort; start again without --cursor",
      );
    }
    if (cursor !== null && cursor.query !== query) {
      throw new TasksPageCursorError(
        "cursor_query_mismatch",
        "task-list cursor does not match the current filters; start again without --cursor",
      );
    }

    const orderBy =
      sort === "manual"
        ? "cursor_project_id, cursor_status, cursor_position, cursor_id"
        : sort === "priority"
          ? "cursor_priority, cursor_due_null, cursor_due_date, cursor_project_id, cursor_status, cursor_position, cursor_id"
          : "cursor_due_null, cursor_due_date, cursor_priority, cursor_project_id, cursor_status, cursor_position, cursor_id";
    const cursorWhere =
      cursor === null
        ? ""
        : sort === "manual"
          ? "WHERE (cursor_project_id, cursor_status, cursor_position, cursor_id) > (@cursorProjectId, @cursorStatus, @cursorPosition, @cursorId)"
          : sort === "priority"
            ? "WHERE (cursor_priority, cursor_due_null, cursor_due_date, cursor_project_id, cursor_status, cursor_position, cursor_id) > (@cursorPriority, @cursorDueNull, @cursorDueDate, @cursorProjectId, @cursorStatus, @cursorPosition, @cursorId)"
            : "WHERE (cursor_due_null, cursor_due_date, cursor_priority, cursor_project_id, cursor_status, cursor_position, cursor_id) > (@cursorDueNull, @cursorDueDate, @cursorPriority, @cursorProjectId, @cursorStatus, @cursorPosition, @cursorId)";
    if (cursor !== null) {
      parameters.cursorPriority = cursor.key.priority;
      parameters.cursorDueNull = cursor.key.dueNull;
      parameters.cursorDueDate = cursor.key.dueDate;
      parameters.cursorProjectId = cursor.key.projectId;
      parameters.cursorStatus = cursor.key.status;
      parameters.cursorPosition = cursor.key.position;
      parameters.cursorId = cursor.key.id;
    }
    parameters.pageLimit = limit + 1;
    const filteredWhere =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const readPage = db.transaction((): ListTasksPage => {
      const revision = db
        .prepare<[], TaskListRevisionRow>(
          "SELECT revision FROM task_list_revision WHERE id = 1",
        )
        .get()?.revision;
      if (revision === undefined) {
        throw new Error("Task-list revision state is unavailable");
      }
      if (cursor !== null && cursor.revision !== revision) {
        throw new TasksPageCursorError(
          "stale_cursor",
          "task-list data changed after this cursor was issued; restart pagination without --cursor",
        );
      }

      const rows = db
        .prepare<Record<string, SqlParameter>, TaskPageRow>(
          `
            WITH filtered_tasks AS (
              SELECT
                t.*,
                p.prefix AS project_prefix,
                CASE t.priority
                  WHEN 'urgent' THEN 0
                  WHEN 'high' THEN 1
                  WHEN 'medium' THEN 2
                  WHEN 'low' THEN 3
                  WHEN 'none' THEN 4
                  ELSE 5
                END AS cursor_priority,
                CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END AS cursor_due_null,
                COALESCE(t.due_date, '') AS cursor_due_date,
                t.project_id AS cursor_project_id,
                t.status AS cursor_status,
                t.position AS cursor_position,
                t.id AS cursor_id
              FROM tasks t
              JOIN projects p ON p.id = t.project_id
              ${filteredWhere}
            )
            SELECT *
            FROM filtered_tasks
            ${cursorWhere}
            ORDER BY ${orderBy}
            LIMIT @pageLimit
          `,
        )
        .all(parameters);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        tasks: pageRows.map(taskFromRow),
        nextCursor:
          hasMore && last !== undefined
            ? encodeTaskCursor({
                version: 1,
                revision,
                query,
                sort,
                key: {
                  priority: last.cursor_priority,
                  dueNull: last.cursor_due_null,
                  dueDate: last.cursor_due_date,
                  projectId: last.cursor_project_id,
                  status: last.cursor_status,
                  position: last.cursor_position,
                  id: last.cursor_id,
                },
              })
            : null,
      };
    });

    return readPage();
  }

  function listTasks(filters: ListTasksFilters = {}): Task[] {
    const unpagedFilters: ListTasksFilters = { ...filters };
    delete unpagedFilters.limit;
    delete unpagedFilters.cursor;
    const tasks: Task[] = [];
    let cursor: string | undefined;
    do {
      const page = listTasksPage({
        ...unpagedFilters,
        limit: TASKS_PAGE_MAX_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      tasks.push(...page.tasks);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return tasks;
  }

  function listSubtasks(parentTaskId: string): Task[] {
    requireTask(parentTaskId);
    return db
      .prepare<[string], TaskRow>(
        `
        ${taskSelect}
        WHERE t.parent_task_id = ?
        ORDER BY t.position, t.created_at, t.id
      `,
      )
      .all(parentTaskId)
      .map(taskFromRow);
  }

  function getSubtaskDoneCounts(parentTaskId: string): SubtaskDoneCounts {
    requireTask(parentTaskId);
    return (
      db
        .prepare<[string], SubtaskDoneCounts>(
          `
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
        FROM tasks WHERE parent_task_id = ?
      `,
        )
        .get(parentTaskId) ?? { total: 0, done: 0 }
    );
  }

  const updateTaskTransaction = db.transaction(
    (id: string, input: UpdateTaskInput): Task => {
      const current = requireTask(id);
      const status = input.status ?? current.status;
      const parentTaskId =
        input.parentTaskId === undefined
          ? current.parentTaskId
          : input.parentTaskId;
      validateTaskParent(current.projectId, parentTaskId, id);

      let position = current.position;
      if (status !== current.status) {
        position =
          db
            .prepare<[string, Task["status"]], { position: number }>(
              `
              SELECT COALESCE(MAX(position), 0) + ${POSITION_STEP} AS position
              FROM tasks WHERE project_id = ? AND status = ?
            `,
            )
            .get(current.projectId, status)?.position ?? POSITION_STEP;
      }

      db.prepare<
        [
          string,
          string,
          Task["status"],
          Task["priority"],
          string | null,
          string | null,
          number,
          string,
          string,
        ]
      >(
        `
        UPDATE tasks SET
          title = ?, description = ?, status = ?, priority = ?, due_date = ?,
          parent_task_id = ?, position = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(
        input.title === undefined
          ? current.title
          : requireNonEmpty(input.title, "Task title"),
        input.description ?? current.description,
        status,
        input.priority ?? current.priority,
        input.dueDate === undefined
          ? current.dueDate
          : validateDueDate(input.dueDate),
        parentTaskId,
        position,
        nowIso(),
        id,
      );
      return requireTask(id);
    },
  );

  function updateTask(id: string, input: UpdateTaskInput): Task {
    return updateTaskTransaction(id, input);
  }

  function renormalizeColumn(
    projectId: string,
    status: Task["status"],
    excludedTaskId: string,
  ): void {
    const rows = db
      .prepare<[string, Task["status"], string], { id: string }>(
        `
        SELECT id FROM tasks
        WHERE project_id = ? AND status = ? AND id <> ?
        ORDER BY position, id
      `,
      )
      .all(projectId, status, excludedTaskId);
    const update = db.prepare<[number, string]>(
      "UPDATE tasks SET position = ? WHERE id = ?",
    );
    rows.forEach((row, index) =>
      update.run((index + 1) * POSITION_STEP, row.id),
    );
  }

  const updatePositionTransaction = db.transaction(
    (id: string, input: UpdateTaskPositionInput): Task => {
      const task = requireTask(id);
      if (input.beforeTaskId === id || input.afterTaskId === id) {
        throw new Error("A task cannot be its own reorder neighbor");
      }

      const readNeighbor = (
        neighborId: string | null | undefined,
      ): Task | undefined => {
        if (neighborId == null) return undefined;
        const neighbor = requireTask(neighborId);
        if (
          neighbor.projectId !== task.projectId ||
          neighbor.status !== input.status
        ) {
          throw new Error(
            "Reorder neighbors must be in the destination project and status",
          );
        }
        return neighbor;
      };

      let before = readNeighbor(input.beforeTaskId);
      let after = readNeighbor(input.afterTaskId);
      if (before && after && before.position >= after.position) {
        throw new Error(
          "The before neighbor must sort before the after neighbor",
        );
      }

      const gapIsExhausted =
        before && after
          ? after.position - before.position <= MIN_POSITION_GAP
          : !before && after
            ? after.position <= MIN_POSITION_GAP
            : false;
      if (gapIsExhausted) {
        renormalizeColumn(task.projectId, input.status, id);
        before = readNeighbor(input.beforeTaskId);
        after = readNeighbor(input.afterTaskId);
      }

      let position: number;
      if (before && after) position = (before.position + after.position) / 2;
      else if (before) position = before.position + POSITION_STEP;
      else if (after) position = after.position / 2;
      else {
        position =
          db
            .prepare<[string, Task["status"], string], { position: number }>(
              `
              SELECT COALESCE(MAX(position), 0) + ${POSITION_STEP} AS position
              FROM tasks WHERE project_id = ? AND status = ? AND id <> ?
            `,
            )
            .get(task.projectId, input.status, id)?.position ?? POSITION_STEP;
      }

      db.prepare<[Task["status"], number, string, string]>(
        `
        UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?
      `,
      ).run(input.status, position, nowIso(), id);
      return requireTask(id);
    },
  );

  function updatePosition(id: string, input: UpdateTaskPositionInput): Task {
    return updatePositionTransaction(id, input);
  }

  function deleteTask(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM tasks WHERE id = ?").run(id).changes > 0
    );
  }

  function getLabel(id: string): Label | undefined {
    const row = getLabelRow.get(id);
    return row ? labelFromRow(row) : undefined;
  }

  function requireLabel(id: string): Label {
    const label = getLabel(id);
    if (!label) throw new Error(`Label not found: ${id}`);
    return label;
  }

  function createLabel(input: CreateLabelInput): Label {
    const id = createOrValidateUlid(input.id);
    requireProject(input.projectId);
    db.prepare<[string, string, string, string]>(
      `
      INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)
    `,
    ).run(
      id,
      input.projectId,
      requireNonEmpty(input.name, "Label name"),
      requireNonEmpty(input.color, "Label color"),
    );
    return requireLabel(id);
  }

  function listLabels(projectId: string): Label[] {
    return db
      .prepare<[string], LabelRow>(
        "SELECT * FROM labels WHERE project_id = ? ORDER BY name COLLATE NOCASE, id",
      )
      .all(projectId)
      .map(labelFromRow);
  }

  function updateLabel(id: string, input: UpdateLabelInput): Label {
    const current = requireLabel(id);
    db.prepare<[string, string, string]>(
      "UPDATE labels SET name = ?, color = ? WHERE id = ?",
    ).run(
      input.name === undefined
        ? current.name
        : requireNonEmpty(input.name, "Label name"),
      input.color === undefined
        ? current.color
        : requireNonEmpty(input.color, "Label color"),
      id,
    );
    return requireLabel(id);
  }

  function deleteLabel(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM labels WHERE id = ?").run(id).changes >
      0
    );
  }

  function addTaskLabel(taskId: string, labelId: string): TaskLabel {
    const task = requireTask(taskId);
    const label = requireLabel(labelId);
    if (task.projectId !== label.projectId) {
      throw new Error("A task can only use labels from its own project");
    }
    db.prepare<[string, string]>(
      `
      INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)
      ON CONFLICT (task_id, label_id) DO NOTHING
    `,
    ).run(taskId, labelId);
    return { taskId, labelId };
  }

  function removeTaskLabel(taskId: string, labelId: string): boolean {
    return (
      db
        .prepare<[string, string]>(
          "DELETE FROM task_labels WHERE task_id = ? AND label_id = ?",
        )
        .run(taskId, labelId).changes > 0
    );
  }

  function listTaskLabels(taskId: string): TaskLabel[] {
    return db
      .prepare<[string], TaskLabelRow>(
        "SELECT task_id, label_id FROM task_labels WHERE task_id = ? ORDER BY label_id",
      )
      .all(taskId)
      .map(taskLabelFromRow);
  }

  function listLabelsForTask(taskId: string): Label[] {
    return db
      .prepare<[string], LabelRow>(
        `
        SELECT l.* FROM labels l
        JOIN task_labels tl ON tl.label_id = l.id
        WHERE tl.task_id = ?
        ORDER BY l.name COLLATE NOCASE, l.id
      `,
      )
      .all(taskId)
      .map(labelFromRow);
  }

  function getComment(id: string): Comment | undefined {
    const row = getCommentRow.get(id);
    return row ? commentFromRow(row) : undefined;
  }

  function requireComment(id: string): Comment {
    const comment = getComment(id);
    if (!comment) throw new Error(`Comment not found: ${id}`);
    return comment;
  }

  function createComment(input: CreateCommentInput): Comment {
    const id = createOrValidateUlid(input.id);
    requireTask(input.taskId);
    db.prepare<
      [
        string,
        string,
        Comment["kind"],
        string,
        string | null,
        string | null,
        string,
        number,
        string,
      ]
    >(
      `
      INSERT INTO comments (
        id, task_id, kind, author_name, preset_name, thread_id, body,
        notified_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      input.taskId,
      input.kind,
      requireNonEmpty(input.authorName, "Comment authorName"),
      input.presetName ?? null,
      validateThreadId(input.threadId ?? null),
      input.body,
      input.notifiedCount ?? 0,
      nowIso(),
    );
    return requireComment(id);
  }

  function listComments(taskId: string): Comment[] {
    return db
      .prepare<[string], CommentRow>(
        `
        SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, rowid
      `,
      )
      .all(taskId)
      .map(commentFromRow);
  }

  function getLatestAgentComment(
    taskId: string,
    excludeCommentId: string | null,
  ): Comment | undefined {
    const row = db
      .prepare<[string, string | null, string | null], CommentRow>(
        `
        SELECT * FROM comments
        WHERE task_id = ?
          AND kind = 'agent'
          AND (? IS NULL OR id <> ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `,
      )
      .get(taskId, excludeCommentId, excludeCommentId);
    return row ? commentFromRow(row) : undefined;
  }

  function updateComment(id: string, input: UpdateCommentInput): Comment {
    const current = requireComment(id);
    db.prepare<[string, number, string]>(
      `
      UPDATE comments SET body = ?, notified_count = ? WHERE id = ?
    `,
    ).run(
      input.body ?? current.body,
      input.notifiedCount ?? current.notifiedCount,
      id,
    );
    return requireComment(id);
  }

  function deleteComment(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM comments WHERE id = ?").run(id)
        .changes > 0
    );
  }

  function getAttachment(id: string): Attachment | undefined {
    const row = getAttachmentRow.get(id);
    return row ? attachmentFromRow(row) : undefined;
  }

  function requireAttachment(id: string): Attachment {
    const attachment = getAttachment(id);
    if (!attachment) throw new Error(`Attachment not found: ${id}`);
    return attachment;
  }

  function createAttachment(input: CreateAttachmentInput): Attachment {
    const taskId = input.taskId ?? null;
    const commentId = input.commentId ?? null;
    if ((taskId === null) === (commentId === null)) {
      throw new Error(
        "An attachment must belong to exactly one task or comment",
      );
    }
    if (taskId !== null) requireTask(taskId);
    if (commentId !== null) requireComment(commentId);
    const id = createOrValidateUlid(input.id);
    db.prepare<
      [
        string,
        string | null,
        string | null,
        string,
        string,
        number,
        string,
        number,
        string,
      ]
    >(
      `
      INSERT INTO attachments (
        id, task_id, comment_id, file_name, mime, size_bytes, blob_path,
        is_image, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      taskId,
      commentId,
      requireNonEmpty(input.fileName, "Attachment fileName"),
      requireNonEmpty(input.mime, "Attachment mime"),
      input.sizeBytes,
      validateBlobPath(input.blobPath),
      input.isImage ? 1 : 0,
      nowIso(),
    );
    return requireAttachment(id);
  }

  function listAttachmentsForTask(taskId: string): Attachment[] {
    return db
      .prepare<[string], AttachmentRow>(
        `
        SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id
      `,
      )
      .all(taskId)
      .map(attachmentFromRow);
  }

  function listAttachmentsForComment(commentId: string): Attachment[] {
    return db
      .prepare<[string], AttachmentRow>(
        `
        SELECT * FROM attachments WHERE comment_id = ? ORDER BY created_at, id
      `,
      )
      .all(commentId)
      .map(attachmentFromRow);
  }

  function updateAttachment(
    id: string,
    input: UpdateAttachmentInput,
  ): Attachment {
    const current = requireAttachment(id);
    db.prepare<[string, string, number, string, number, string]>(
      `
      UPDATE attachments
      SET file_name = ?, mime = ?, size_bytes = ?, blob_path = ?, is_image = ?
      WHERE id = ?
    `,
    ).run(
      input.fileName === undefined
        ? current.fileName
        : requireNonEmpty(input.fileName, "Attachment fileName"),
      input.mime === undefined
        ? current.mime
        : requireNonEmpty(input.mime, "Attachment mime"),
      input.sizeBytes ?? current.sizeBytes,
      input.blobPath === undefined
        ? current.blobPath
        : validateBlobPath(input.blobPath),
      (input.isImage ?? current.isImage) ? 1 : 0,
      id,
    );
    return requireAttachment(id);
  }

  function deleteAttachment(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM attachments WHERE id = ?").run(id)
        .changes > 0
    );
  }

  function getTaskThread(id: string): TaskThread | undefined {
    const row = getTaskThreadRow.get(id);
    return row ? taskThreadFromRow(row) : undefined;
  }

  function getTaskThreadByThreadId(
    taskId: string,
    threadId: string,
  ): TaskThread | undefined {
    const row = db
      .prepare<[string, string], TaskThreadRow>(
        `
        SELECT * FROM task_threads WHERE task_id = ? AND thread_id = ?
      `,
      )
      .get(taskId, threadId);
    return row ? taskThreadFromRow(row) : undefined;
  }

  function requireTaskThread(id: string): TaskThread {
    const thread = getTaskThread(id);
    if (!thread) throw new Error(`Task thread not found: ${id}`);
    return thread;
  }

  function upsertTaskThread(input: UpsertTaskThreadInput): TaskThread {
    requireTask(input.taskId);
    const id = createOrValidateUlid(input.id);
    const timestamp = nowIso();
    db.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        TaskThreadLiveStatus,
        string,
        string,
      ]
    >(
      `
      INSERT INTO task_threads (
        id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, thread_id) DO UPDATE SET
        preset_name = excluded.preset_name,
        title = excluded.title,
        live_status = excluded.live_status,
        updated_at = excluded.updated_at
    `,
    ).run(
      id,
      input.taskId,
      validateThreadId(input.threadId),
      requireNonEmpty(input.presetName, "Task thread presetName"),
      requireNonEmpty(input.title, "Task thread title"),
      input.liveStatus,
      timestamp,
      timestamp,
    );
    const thread = getTaskThreadByThreadId(input.taskId, input.threadId);
    if (!thread) throw new Error("Task thread upsert failed");
    return thread;
  }

  function listTaskThreads(taskId: string): TaskThread[] {
    return db
      .prepare<[string], TaskThreadRow>(
        `
        SELECT * FROM task_threads
        WHERE task_id = ?
        ORDER BY
          CASE WHEN live_status IN ('completed', 'failed') THEN 1 ELSE 0 END,
          attached_at DESC,
          id DESC
      `,
      )
      .all(taskId)
      .map(taskThreadFromRow);
  }

  function updateTaskThreadStatus(
    id: string,
    liveStatus: TaskThreadLiveStatus,
  ): TaskThread {
    const current = requireTaskThread(id);
    db.prepare<[string, string, TaskThreadLiveStatus, string, string]>(
      `
      UPDATE task_threads
      SET preset_name = ?, title = ?, live_status = ?, updated_at = ?
      WHERE id = ?
    `,
    ).run(current.presetName, current.title, liveStatus, nowIso(), id);
    return requireTaskThread(id);
  }

  function deleteTaskThread(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM task_threads WHERE id = ?").run(id)
        .changes > 0
    );
  }

  function getPreset(id: string): Preset | undefined {
    const row = getPresetRow.get(id);
    return row ? presetFromRow(row) : undefined;
  }

  function requirePreset(id: string): Preset {
    const preset = getPreset(id);
    if (!preset) throw new Error(`Preset not found: ${id}`);
    return preset;
  }

  function createPreset(input: CreatePresetInput): Preset {
    const id = createOrValidateUlid(input.id);
    const environment = validatePresetEnvironment(input);
    db.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        "default" | "fast" | null,
        string,
        PresetEnvironmentKind,
        string | null,
        string | null,
        string,
        number,
        string,
      ]
    >(
      `
      INSERT INTO presets (
        id, name, provider_id, model_id, reasoning_level, service_tier,
        permission_mode,
        environment_kind, base_branch, machine_id, instructions, builtin,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      requireNonEmpty(input.name, "Preset name"),
      requireNonEmpty(input.providerId, "Preset providerId"),
      requireNonEmpty(input.modelId, "Preset modelId"),
      requireNonEmpty(input.reasoningLevel, "Preset reasoningLevel"),
      input.serviceTier,
      requireNonEmpty(input.permissionMode, "Preset permissionMode"),
      environment.environmentKind,
      environment.baseBranch,
      environment.machineId,
      input.instructions,
      input.builtin ? 1 : 0,
      nowIso(),
    );
    return requirePreset(id);
  }

  function listPresets(): Preset[] {
    return db
      .prepare<[], PresetRow>(
        "SELECT * FROM presets ORDER BY builtin DESC, name COLLATE NOCASE, id",
      )
      .all()
      .map(presetFromRow);
  }

  function updatePreset(id: string, input: UpdatePresetInput): Preset {
    const current = requirePreset(id);
    const environment = validatePresetEnvironment({
      environmentKind: input.environmentKind ?? current.environmentKind,
      baseBranch:
        input.baseBranch === undefined ? current.baseBranch : input.baseBranch,
      machineId:
        input.machineId === undefined ? current.machineId : input.machineId,
    });
    db.prepare<
      [
        string,
        string,
        string,
        string,
        "default" | "fast" | null,
        string,
        PresetEnvironmentKind,
        string | null,
        string | null,
        string,
        number,
        string,
      ]
    >(
      `
      UPDATE presets SET
        name = ?, provider_id = ?, model_id = ?, reasoning_level = ?,
        service_tier = ?, permission_mode = ?, environment_kind = ?, base_branch = ?,
        machine_id = ?, instructions = ?, builtin = ?
      WHERE id = ?
    `,
    ).run(
      input.name === undefined
        ? current.name
        : requireNonEmpty(input.name, "Preset name"),
      input.providerId === undefined
        ? current.providerId
        : requireNonEmpty(input.providerId, "Preset providerId"),
      input.modelId === undefined
        ? current.modelId
        : requireNonEmpty(input.modelId, "Preset modelId"),
      input.reasoningLevel === undefined
        ? current.reasoningLevel
        : requireNonEmpty(input.reasoningLevel, "Preset reasoningLevel"),
      input.serviceTier === undefined ? current.serviceTier : input.serviceTier,
      input.permissionMode === undefined
        ? current.permissionMode
        : requireNonEmpty(input.permissionMode, "Preset permissionMode"),
      environment.environmentKind,
      environment.baseBranch,
      environment.machineId,
      input.instructions ?? current.instructions,
      (input.builtin ?? current.builtin) ? 1 : 0,
      id,
    );
    return requirePreset(id);
  }

  function deletePreset(id: string): boolean {
    return (
      db.prepare<[string]>("DELETE FROM presets WHERE id = ?").run(id).changes >
      0
    );
  }

  return {
    createFolder,
    getFolder,
    listFolders,
    updateFolder,
    deleteFolder,
    createProject,
    getProject,
    listProjects,
    updateProject,
    deleteProject,
    createTask,
    getTask,
    getTaskByKey,
    listTasksPage,
    listTasks,
    listSubtasks,
    getSubtaskDoneCounts,
    updateTask,
    updatePosition,
    deleteTask,
    createLabel,
    getLabel,
    listLabels,
    updateLabel,
    deleteLabel,
    addTaskLabel,
    removeTaskLabel,
    listTaskLabels,
    listLabelsForTask,
    createComment,
    getComment,
    listComments,
    getLatestAgentComment,
    updateComment,
    deleteComment,
    createAttachment,
    getAttachment,
    listAttachmentsForTask,
    listAttachmentsForComment,
    updateAttachment,
    deleteAttachment,
    upsertTaskThread,
    getTaskThread,
    getTaskThreadByThreadId,
    listTaskThreads,
    updateTaskThreadStatus,
    deleteTaskThread,
    createPreset,
    getPreset,
    listPresets,
    updatePreset,
    deletePreset,
  };
}

export type TasksStore = ReturnType<typeof createTasksStore>;
