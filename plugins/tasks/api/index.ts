import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  createTasksStore,
  type Attachment as StoredAttachment,
  type Comment as StoredComment,
  type Task as StoredTask,
  type TasksStore,
} from "../db";
import {
  AttachmentReferencedError,
  deleteAttachmentById,
  removeAttachmentBlobs,
} from "../attachments";
import { deliverCommentToLatestAgent } from "../steer";
import { isSideChatShapedThread } from "../shared/side-chat";
import {
  tasksRpcContract,
  type Attachment as AttachmentMetadata,
  type ProjectsChangedEvent,
  type SidebarProjectSummary,
  type Task,
  type TaskPullRequest,
  type TasksChangedEvent,
  type TasksDomainError,
  type TaskStatus,
  type CommentsChangedEvent,
  type CommentProvider,
} from "../shared/contract";

interface TaskLabelIdRow {
  task_id: string;
  label_id: string;
}

interface CountRow {
  count: number;
}

interface PrefixRow {
  found: number;
}

interface SummaryRow {
  project_id: string;
  task_count: number;
  active_agent_count: number;
}

const MAX_THREAD_SEARCH_RESULTS = 10;

export interface TasksApiStore {
  readonly tasks: TasksStore;
  transaction<T>(operation: () => T): T;
  taskLabelIds(taskIds: readonly string[]): Map<string, string[]>;
  projectTaskCount(projectId: string): number;
  projectPrefixExists(prefix: string, excludingProjectId: string): boolean;
  openTaskCount(): number;
  sidebarSummary(): SidebarProjectSummary[];
}

export function createStore(bb: BbPluginApi): TasksApiStore {
  const database = bb.storage.database();
  const tasks = createTasksStore(database);

  return {
    tasks,
    transaction<T>(operation: () => T): T {
      return database.transaction(operation)();
    },
    taskLabelIds(taskIds: readonly string[]): Map<string, string[]> {
      const labelsByTask = new Map<string, string[]>();
      for (const taskId of taskIds) labelsByTask.set(taskId, []);

      for (let offset = 0; offset < taskIds.length; offset += 500) {
        const ids = taskIds.slice(offset, offset + 500);
        if (ids.length === 0) continue;
        const placeholders = ids.map(() => "?").join(", ");
        const rows = database
          .prepare<string[], TaskLabelIdRow>(
            `
              SELECT task_id, label_id
              FROM task_labels
              WHERE task_id IN (${placeholders})
              ORDER BY task_id, label_id
            `,
          )
          .all(...ids);
        for (const row of rows)
          labelsByTask.get(row.task_id)?.push(row.label_id);
      }
      return labelsByTask;
    },
    projectTaskCount(projectId: string): number {
      return (
        database
          .prepare<[string], CountRow>(
            "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
          )
          .get(projectId)?.count ?? 0
      );
    },
    projectPrefixExists(prefix: string, excludingProjectId: string): boolean {
      return Boolean(
        database
          .prepare<[string, string], PrefixRow>(
            `
              SELECT 1 AS found FROM projects
              WHERE prefix = ? COLLATE NOCASE AND id <> ?
              LIMIT 1
            `,
          )
          .get(prefix, excludingProjectId),
      );
    },
    openTaskCount(): number {
      return (
        database
          .prepare<[], CountRow>(
            `
              SELECT COUNT(*) AS count
              FROM tasks
              WHERE status NOT IN ('done', 'canceled')
            `,
          )
          .get()?.count ?? 0
      );
    },
    sidebarSummary(): SidebarProjectSummary[] {
      return database
        .prepare<[], SummaryRow>(
          `
            SELECT
              p.id AS project_id,
              COUNT(DISTINCT t.id) AS task_count,
              COUNT(DISTINCT CASE
                WHEN tt.live_status IN ('starting', 'working') THEN tt.thread_id
              END) AS active_agent_count
            FROM projects p
            LEFT JOIN tasks t
              ON t.project_id = p.id
              AND t.parent_task_id IS NULL
            LEFT JOIN task_threads tt ON tt.task_id = t.id
            GROUP BY p.id
            ORDER BY p.name COLLATE NOCASE, p.id
          `,
        )
        .all()
        .map((row) => ({
          projectId: row.project_id,
          taskCount: row.task_count,
          activeAgentCount: row.active_agent_count,
        }));
    },
  };
}

class TasksDomainFailure extends Error {
  constructor(readonly detail: TasksDomainError) {
    super(detail.message);
    this.name = "TasksDomainFailure";
  }
}

function fail(code: TasksDomainError["code"], message: string): never {
  throw new TasksDomainFailure({ code, message });
}

function taskFailure(error: TasksDomainFailure) {
  return { ok: false as const, error: error.detail };
}

function statusName(status: TaskStatus): string {
  return status
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function priorityName(priority: StoredTask["priority"]): string {
  return priority[0]?.toUpperCase() + priority.slice(1);
}

export function publishTasksChanged(
  bb: BbPluginApi,
  taskId: string,
  projectId: string,
): void {
  const payload: TasksChangedEvent = { taskId, projectId };
  bb.realtime.publish("tasks:changed", payload);
}

export function publishProjectsChanged(
  bb: BbPluginApi,
  projectId: string | null,
): void {
  const payload: ProjectsChangedEvent = { projectId };
  bb.realtime.publish("projects:changed", payload);
}

export function publishCommentsChanged(
  bb: BbPluginApi,
  taskId: string,
  notifiedCount?: number,
): void {
  const payload: CommentsChangedEvent = {
    taskId,
    ...(notifiedCount === undefined ? {} : { notifiedCount }),
  };
  bb.realtime.publish("comments:changed", payload);
}

function apiTask(store: TasksApiStore, task: StoredTask): Task {
  return {
    ...task,
    labelIds: store.taskLabelIds([task.id]).get(task.id) ?? [],
  };
}

function apiTasks(store: TasksApiStore, tasks: StoredTask[]): Task[] {
  const labelsByTask = store.taskLabelIds(tasks.map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    labelIds: labelsByTask.get(task.id) ?? [],
  }));
}

function validateTaskParent(
  store: TasksApiStore,
  projectId: string,
  parentTaskId: string | null,
  ownTaskId?: string,
): void {
  if (parentTaskId === null) return;
  if (parentTaskId === ownTaskId) {
    fail("task_parent_invalid", "A task cannot be its own parent");
  }

  const parent = store.tasks.getTask(parentTaskId);
  if (!parent) throw new Error(`Task not found: ${parentTaskId}`);
  if (parent.projectId !== projectId) {
    fail(
      "subtask_project_mismatch",
      "A sub-task must belong to the same project as its parent",
    );
  }
  if (parent.parentTaskId !== null) {
    fail(
      "subtask_depth_exceeded",
      "Tasks support at most one level of sub-tasks",
    );
  }
  if (ownTaskId && store.tasks.listSubtasks(ownTaskId).length > 0) {
    fail(
      "subtask_depth_exceeded",
      "A task with sub-tasks cannot itself become a sub-task",
    );
  }
}

function validateTaskLabels(
  store: TasksApiStore,
  projectId: string,
  labelIds: readonly string[],
): void {
  for (const labelId of labelIds) {
    const label = store.tasks.getLabel(labelId);
    if (!label || label.projectId !== projectId) {
      fail(
        "label_project_mismatch",
        `Task labels must belong to the task project: ${labelId}`,
      );
    }
  }
}

function replaceTaskLabels(
  store: TasksApiStore,
  taskId: string,
  labelIds: readonly string[],
): void {
  const current = new Set(
    store.tasks.listTaskLabels(taskId).map((link) => link.labelId),
  );
  const next = new Set(labelIds);
  for (const labelId of current) {
    if (!next.has(labelId)) store.tasks.removeTaskLabel(taskId, labelId);
  }
  for (const labelId of next) {
    if (!current.has(labelId)) store.tasks.addTaskLabel(taskId, labelId);
  }
}

function labelsChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (before.length !== after.length) return true;
  const afterSet = new Set(after);
  return before.some((labelId) => !afterSet.has(labelId));
}

function labelChangeBody(
  store: TasksApiStore,
  taskId: string,
  authorName: string,
): string {
  const names = store.tasks
    .listLabelsForTask(taskId)
    .map((label) => label.name)
    .sort((left, right) => left.localeCompare(right));
  return names.length === 0
    ? `Labels cleared by ${authorName}`
    : `Labels changed to ${names.join(", ")} by ${authorName}`;
}

function writeSystemComments(
  store: TasksApiStore,
  taskId: string,
  authorName: string,
  bodies: readonly string[],
): void {
  for (const body of bodies) {
    store.tasks.createComment({
      taskId,
      kind: "system",
      authorName,
      body,
      notifiedCount: 0,
    });
  }
}

function attachmentMetadata(attachment: StoredAttachment): AttachmentMetadata {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    commentId: attachment.commentId,
    fileName: attachment.fileName,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    isImage: attachment.isImage,
    createdAt: attachment.createdAt,
  };
}

function attachmentsForTasks(
  store: TasksStore,
  taskIds: readonly string[],
): StoredAttachment[] {
  return taskIds.flatMap((taskId) => [
    ...store.listAttachmentsForTask(taskId),
    ...store
      .listComments(taskId)
      .flatMap((comment) => store.listAttachmentsForComment(comment.id)),
  ]);
}

interface AgentThreadInfo {
  title: string | null;
  providerId: string;
}

async function resolveAgentThreadInfo(
  bb: BbPluginApi,
  comments: readonly StoredComment[],
): Promise<Map<string, AgentThreadInfo>> {
  const threadIds = new Set<string>();
  for (const comment of comments) {
    if (comment.kind === "agent" && comment.threadId !== null) {
      threadIds.add(comment.threadId);
    }
  }
  const infos = new Map<string, AgentThreadInfo>();
  await Promise.all(
    [...threadIds].map(async (threadId) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const isSideChat = isSideChatShapedThread(thread);
        const title = isSideChat
          ? undefined
          : [thread.title, thread.titleFallback].find(
              (candidate) => candidate !== null && candidate.trim() !== "",
            );
        infos.set(threadId, {
          title: title ?? null,
          providerId: thread.providerId,
        });
      } catch {}
    }),
  );
  return infos;
}

async function resolveProviderBadges(
  bb: BbPluginApi,
  threadInfo: ReadonlyMap<string, AgentThreadInfo>,
): Promise<Map<string, CommentProvider>> {
  const providerIds = new Set(
    [...threadInfo.values()].map((info) => info.providerId),
  );
  const badges = new Map<string, CommentProvider>();
  if (providerIds.size === 0) return badges;
  let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
  try {
    providers = await bb.sdk.providers.list();
  } catch {
    return badges;
  }
  for (const provider of providers) {
    if (providerIds.has(provider.id)) {
      badges.set(provider.id, {
        id: provider.id,
        name: provider.displayName,
        logoUrl: provider.logoUrl,
      });
    }
  }
  return badges;
}

interface CreateCommentInput {
  taskId: string;
  kind: StoredComment["kind"];
  authorName: string;
  presetName: string | null;
  threadId: string | null;
  body: string;
  notify: boolean;
}

export async function createComment(
  bb: BbPluginApi,
  store: TasksApiStore,
  input: CreateCommentInput,
): Promise<StoredComment> {
  let comment = store.transaction(() =>
    store.tasks.createComment({
      taskId: input.taskId,
      kind: input.kind,
      authorName: input.authorName,
      presetName: input.presetName,
      threadId: input.threadId,
      body: input.body,
      notifiedCount: 0,
    }),
  );

  if (input.notify) {
    const delivery = await deliverCommentToLatestAgent(bb, store.tasks, {
      taskId: comment.taskId,
      commentId: comment.id,
      body: comment.body,
      authorName: comment.authorName,
    });
    comment = store.transaction(() =>
      store.tasks.updateComment(comment.id, {
        notifiedCount: delivery.notifiedCount,
      }),
    );
  }

  publishCommentsChanged(bb, input.taskId, comment.notifiedCount);
  return comment;
}

interface TaskPullRequestsResult {
  pullRequests: TaskPullRequest[];
  unavailableThreadIds: string[];
}

const PULL_REQUEST_LOOKUP_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await work(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function listTaskPullRequests(
  bb: BbPluginApi,
  store: TasksApiStore,
  taskId: string,
): Promise<TaskPullRequestsResult> {
  const taskThreads = store.tasks.listTaskThreads(taskId);

  const unavailable = new Set<string>();
  const threadIdsByEnvironment = new Map<string, string[]>();
  await Promise.all(
    taskThreads.map(async (taskThread) => {
      try {
        const thread = await bb.sdk.threads.get({
          threadId: taskThread.threadId,
        });
        if (!thread.environmentId) return;
        const group = threadIdsByEnvironment.get(thread.environmentId) ?? [];
        group.push(taskThread.threadId);
        threadIdsByEnvironment.set(thread.environmentId, group);
      } catch {
        unavailable.add(taskThread.threadId);
      }
    }),
  );

  const byUrl = new Map<string, TaskPullRequest>();
  await mapWithConcurrency(
    [...threadIdsByEnvironment.entries()],
    PULL_REQUEST_LOOKUP_CONCURRENCY,
    async ([environmentId, threadIds]) => {
      let result: Awaited<
        ReturnType<BbPluginApi["sdk"]["environments"]["pullRequest"]>
      >;
      try {
        result = await bb.sdk.environments.pullRequest({ environmentId });
      } catch {
        for (const threadId of threadIds) unavailable.add(threadId);
        return;
      }
      if (result.outcome === "unavailable") {
        for (const threadId of threadIds) unavailable.add(threadId);
        return;
      }
      if (result.outcome === "absent") return;
      const { pullRequest } = result;
      const existing = byUrl.get(pullRequest.url);
      if (!existing) {
        byUrl.set(pullRequest.url, {
          url: pullRequest.url,
          number: pullRequest.number,
          title: pullRequest.title,
          state: pullRequest.state,
          updatedAt: pullRequest.updatedAt,
          threadIds: [...threadIds],
        });
        return;
      }
      const threadIdUnion = [...existing.threadIds, ...threadIds];
      if (pullRequest.updatedAt.localeCompare(existing.updatedAt) > 0) {
        byUrl.set(pullRequest.url, {
          url: pullRequest.url,
          number: pullRequest.number,
          title: pullRequest.title,
          state: pullRequest.state,
          updatedAt: pullRequest.updatedAt,
          threadIds: threadIdUnion,
        });
      } else {
        existing.threadIds = threadIdUnion;
      }
    },
  );

  const threadOrder = new Map(
    taskThreads.map((taskThread, index) => [taskThread.threadId, index]),
  );
  const orderByThread = (threadId: string) =>
    threadOrder.get(threadId) ?? Number.MAX_SAFE_INTEGER;
  const pullRequests = [...byUrl.values()].map((pullRequest) => ({
    ...pullRequest,
    threadIds: [...pullRequest.threadIds].sort(
      (left, right) => orderByThread(left) - orderByThread(right),
    ),
  }));

  return {
    pullRequests: pullRequests.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ),
    unavailableThreadIds: [...unavailable].sort(
      (left, right) => orderByThread(left) - orderByThread(right),
    ),
  };
}

export function registerHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): PluginRpcHandlers<typeof tasksRpcContract> {
  return {
    createFolder(input) {
      const folder = store.tasks.createFolder(input);
      publishProjectsChanged(bb, null);
      return { folder };
    },
    renameFolder(input) {
      const folder = store.tasks.updateFolder(input.folderId, {
        name: input.name,
      });
      publishProjectsChanged(bb, null);
      return { folder };
    },
    moveFolder(input) {
      const folder = store.tasks.updateFolder(input.folderId, {
        parentFolderId: input.parentFolderId,
      });
      publishProjectsChanged(bb, null);
      return { folder };
    },
    deleteFolder(input) {
      const result = store.tasks.deleteFolder(input.folderId);
      if (result.deleted) publishProjectsChanged(bb, null);
      return result;
    },
    listFolders() {
      return { folders: store.tasks.listFolders() };
    },
    createProject(input) {
      const project = store.tasks.createProject(input);
      publishProjectsChanged(bb, project.id);
      return { project };
    },
    updateProject(input) {
      const { projectId, ...changes } = input;
      const project = store.tasks.updateProject(projectId, changes);
      publishProjectsChanged(bb, project.id);
      return { project };
    },
    renameProjectPrefix(input) {
      try {
        if (store.projectPrefixExists(input.prefix, input.projectId)) {
          fail(
            "project_prefix_conflict",
            `Project prefix is already in use: ${input.prefix}`,
          );
        }
        const project = store.tasks.updateProject(input.projectId, {
          prefix: input.prefix,
        });
        publishProjectsChanged(bb, project.id);
        return { ok: true, project };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    async deleteProject(input) {
      try {
        if (!input.force && store.projectTaskCount(input.projectId) > 0) {
          fail(
            "project_not_empty",
            "A project must be empty before it can be deleted; pass force: true to delete its tasks",
          );
        }
        const taskIds = store.tasks
          .listTasks({ projectId: input.projectId })
          .map((task) => task.id);
        const attachments = attachmentsForTasks(store.tasks, taskIds);
        const deleted = store.tasks.deleteProject(input.projectId);
        if (deleted) {
          await removeAttachmentBlobs(bb, store.tasks, attachments);
          publishProjectsChanged(bb, input.projectId);
        }
        return { ok: true, deleted };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    listProjects(input) {
      return { projects: store.tasks.listProjects(input.folderId) };
    },
    createTask(input) {
      try {
        validateTaskParent(store, input.projectId, input.parentTaskId);
        validateTaskLabels(store, input.projectId, input.labelIds);
        const task = store.transaction(() => {
          const created = store.tasks.createTask({
            projectId: input.projectId,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            dueDate: input.dueDate,
            parentTaskId: input.parentTaskId,
          });
          replaceTaskLabels(store, created.id, input.labelIds);
          return apiTask(store, created);
        });
        publishTasksChanged(bb, task.id, task.projectId);
        return { ok: true, task };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    getTask(input) {
      const task = store.tasks.getTask(input.taskId);
      return { task: task ? apiTask(store, task) : null };
    },
    getTaskByKey(input) {
      const task = store.tasks.getTaskByKey(input.taskKey);
      return { task: task ? apiTask(store, task) : null };
    },
    updateTask(input) {
      try {
        const current = store.tasks.getTask(input.taskId);
        if (!current) throw new Error(`Task not found: ${input.taskId}`);
        const parentTaskId =
          input.parentTaskId === undefined
            ? current.parentTaskId
            : input.parentTaskId;
        validateTaskParent(store, current.projectId, parentTaskId, current.id);
        if (input.labelIds) {
          validateTaskLabels(store, current.projectId, input.labelIds);
        }

        const result = store.transaction(() => {
          const beforeLabelIds = store.tasks
            .listTaskLabels(current.id)
            .map((link) => link.labelId);
          const updated = store.tasks.updateTask(current.id, {
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            dueDate: input.dueDate,
            parentTaskId: input.parentTaskId,
          });
          if (input.labelIds) {
            replaceTaskLabels(store, current.id, input.labelIds);
          }

          const bodies: string[] = [];
          if (updated.status !== current.status) {
            bodies.push(
              `Status changed to ${statusName(updated.status)} by ${input.authorName}`,
            );
          }
          if (updated.priority !== current.priority) {
            bodies.push(
              `Priority changed to ${priorityName(updated.priority)} by ${input.authorName}`,
            );
          }
          if (updated.dueDate !== current.dueDate) {
            bodies.push(
              updated.dueDate === null
                ? `Due date removed by ${input.authorName}`
                : `Due date changed to ${updated.dueDate} by ${input.authorName}`,
            );
          }
          if (input.labelIds && labelsChanged(beforeLabelIds, input.labelIds)) {
            bodies.push(labelChangeBody(store, current.id, input.authorName));
          }
          writeSystemComments(store, current.id, input.authorName, bodies);
          return {
            task: apiTask(store, updated),
            systemCommentsWritten: bodies.length,
          };
        });

        publishTasksChanged(bb, result.task.id, result.task.projectId);
        if (result.systemCommentsWritten > 0) {
          publishCommentsChanged(bb, result.task.id);
        }
        return { ok: true, task: result.task };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    async deleteTask(input) {
      const task = store.tasks.getTask(input.taskId);
      const attachments = attachmentsForTasks(store.tasks, [input.taskId]);
      const deleted = store.tasks.deleteTask(input.taskId);
      if (deleted && task) {
        await removeAttachmentBlobs(bb, store.tasks, attachments);
        publishTasksChanged(bb, task.id, task.projectId);
      }
      return { deleted };
    },
    listTasks(input) {
      const page = store.tasks.listTasksPage({
        projectId: input.projectId,
        statuses: input.statuses,
        priorities: input.priorities,
        labelIds: input.labelIds,
        activeOnly: input.activeOnly,
        parentTaskId: input.parentTaskId,
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        tasks: apiTasks(store, page.tasks),
        nextCursor: page.nextCursor,
      };
    },
    boardMove(input) {
      const current = store.tasks.getTask(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      const result = store.transaction(() => {
        const moved = store.tasks.updatePosition(current.id, {
          status: input.status,
          beforeTaskId: input.beforeTaskId,
          afterTaskId: input.afterTaskId,
        });
        const statusChanged = moved.status !== current.status;
        if (statusChanged) {
          writeSystemComments(store, current.id, input.authorName, [
            `Status changed to ${statusName(moved.status)} by ${input.authorName}`,
          ]);
        }
        return { task: apiTask(store, moved), statusChanged };
      });
      publishTasksChanged(bb, result.task.id, result.task.projectId);
      if (result.statusChanged) publishCommentsChanged(bb, result.task.id);
      return { ok: true, task: result.task };
    },
    createLabel(input) {
      const label = store.tasks.createLabel(input);
      publishProjectsChanged(bb, label.projectId);
      return { label };
    },
    updateLabel(input) {
      const label = store.tasks.updateLabel(input.labelId, {
        name: input.name,
        color: input.color,
      });
      publishProjectsChanged(bb, label.projectId);
      return { label };
    },
    deleteLabel(input) {
      const label = store.tasks.getLabel(input.labelId);
      const deleted = store.tasks.deleteLabel(input.labelId);
      if (deleted && label) publishProjectsChanged(bb, label.projectId);
      return { deleted };
    },
    listLabels(input) {
      return { labels: store.tasks.listLabels(input.projectId) };
    },
    async createComment(input) {
      const comment = await createComment(bb, store, {
        taskId: input.taskId,
        kind: "user",
        authorName: "You",
        presetName: null,
        threadId: null,
        body: input.body,
        notify: input.notify,
      });
      return { comment };
    },
    async listComments(input) {
      const comments = store.tasks.listComments(input.taskId);
      const threadInfo = await resolveAgentThreadInfo(bb, comments);
      const providerBadges = await resolveProviderBadges(bb, threadInfo);
      return {
        comments: comments.map((comment) => {
          const info =
            comment.kind === "agent" && comment.threadId !== null
              ? threadInfo.get(comment.threadId)
              : undefined;
          return {
            ...comment,
            threadTitle: info?.title ?? null,
            provider:
              info === undefined
                ? null
                : (providerBadges.get(info.providerId) ?? {
                    id: info.providerId,
                    name: info.providerId,
                    logoUrl: null,
                  }),
          };
        }),
      };
    },
    listAttachments(input) {
      const attachments =
        "taskId" in input
          ? store.tasks.listAttachmentsForTask(input.taskId)
          : store.tasks.listAttachmentsForComment(input.commentId);
      return {
        attachments: attachments.map(attachmentMetadata),
      };
    },
    async deleteAttachment(input) {
      try {
        const attachment = await deleteAttachmentById(
          bb,
          store.tasks,
          input.attachmentId,
          {
            removeDescriptionReferences: input.removeDescriptionReferences,
          },
        );
        return attachment
          ? {
              ok: true,
              deleted: true,
              attachment: attachmentMetadata(attachment),
            }
          : { ok: true, deleted: false, attachment: null };
      } catch (error) {
        if (error instanceof AttachmentReferencedError) {
          return {
            ok: false,
            error: {
              code: "attachment_referenced",
              message: error.message,
            },
          };
        }
        throw error;
      }
    },
    listTaskThreads(input) {
      return { taskThreads: store.tasks.listTaskThreads(input.taskId) };
    },
    async listTaskPullRequests(input) {
      return listTaskPullRequests(bb, store, input.taskId);
    },
    createPreset(input) {
      const preset = store.tasks.createPreset({ ...input, builtin: false });
      publishProjectsChanged(bb, null);
      return { preset };
    },
    updatePreset(input) {
      const { presetId, ...changes } = input;
      const preset = store.tasks.updatePreset(
        presetId,
        changes.environmentKind === "project-default"
          ? { ...changes, baseBranch: null, machineId: null }
          : changes,
      );
      publishProjectsChanged(bb, null);
      return { preset };
    },
    deletePreset(input) {
      const deleted = store.tasks.deletePreset(input.presetId);
      if (deleted) publishProjectsChanged(bb, null);
      return { deleted };
    },
    listPresets() {
      return { presets: store.tasks.listPresets() };
    },
    async listMachines() {
      const machines = await bb.sdk.hosts.list();
      return {
        machines: machines.map((machine) => ({
          id: machine.id,
          name: machine.name,
        })),
      };
    },
    async searchThreads(input) {
      const query = input.query.trim();
      const limit = Math.min(input.limit ?? MAX_THREAD_SEARCH_RESULTS, 10);
      const candidates =
        query.length >= 2
          ? await bb.sdk.threads.search({
              query,
              limitPerGroup: String(MAX_THREAD_SEARCH_RESULTS),
            })
          : null;
      const threads = candidates
        ? [...candidates.active.results, ...candidates.archived.results].map(
            (result) => result.thread,
          )
        : (
            await bb.sdk.threads.list({
              limit: MAX_THREAD_SEARCH_RESULTS,
            })
          ).filter((thread) => {
            if (query.length === 0) return true;
            const title = thread.title ?? thread.titleFallback ?? "";
            return title
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase());
          });
      return {
        threads: threads
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, limit)
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
            status: thread.status,
          })),
      };
    },
    async listBbProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        bbProjects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      };
    },
    sidebarOpenTaskCount() {
      return { openTaskCount: store.openTaskCount() };
    },
    sidebarSummary() {
      return { projects: store.sidebarSummary() };
    },
  };
}

export function registerTasksApi(bb: BbPluginApi, store: TasksApiStore): void {
  bb.rpc.register(tasksRpcContract, registerHandlers(bb, store));
}
