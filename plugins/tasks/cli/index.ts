import { resolve } from "node:path";
import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  createComment,
  publishProjectsChanged,
  registerHandlers,
  type TasksApiStore,
} from "../api";
import {
  buildAttachmentUrl,
  publishAttachmentChanged,
  readAttachmentContent,
  saveAttachmentFromBytes,
} from "../attachments";
import { delegationRpcContract } from "../delegate/contract";
import { handlers as delegationHandlers } from "../delegate";
import {
  tasksRpcContract,
  type Attachment,
  type Folder,
  type Label,
  type Project,
  type Preset,
  type Task,
  type TaskMutationResult,
} from "../shared/contract";
import {
  TASK_SORTS,
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
} from "../shared/pagination";
import {
  assertAllowed,
  CliError,
  option,
  options,
  parseArgs,
  requireOption,
  requirePositionals,
  type ParsedArgs,
} from "./args";
import { bytes, detail, table } from "./format";
import { seedDemo } from "./seed";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TASK_KEY_PATTERN = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/;
const ACTIVE_THREAD_STATUSES = new Set(["starting", "working"]);
const DEFAULT_PROJECT_COLOR = "blue";
const DEFAULT_LABEL_COLOR = "gray";

const ROOT_HELP = `Usage: bb tasks <command> [options]

Commands:
  status                         Show plugin status
  project create|list|show|update
  folder create|list|update|delete
  create                         Create a task
  list                           List tasks
  show                           Show full task details
  update                         Update a task
  comment                        Add a task comment
  label create|list|delete
  attachment add|get|list|remove
  preset list|show|create|update|delete
  dispatch                       Dispatch a task to a new agent thread
  attach                         Attach an agent thread to a task
  detach                         Detach an agent thread from a task
  threads                        List threads attached to a task
  seed-demo                      Create sample data (requires --yes)

Run bb tasks <command> --help for command usage.`;

const PROJECT_HELP = `Usage:
  bb tasks project create --name <name> [--prefix X] [--folder <id-or-name>] [--link-bb-project <proj_id>] [--color <color>] [--json]
  bb tasks project list [--json]
  bb tasks project show <prefix-or-id> [--json]
  bb tasks project update <prefix-or-id> [--name <name>] [--color <color>] [--folder <id-or-name> | --no-folder] [--link-bb-project <proj_id> | --unlink-bb-project] [--rename-prefix X] [--json]`;

const FOLDER_HELP = `Usage:
  bb tasks folder create --name <name> [--parent <id-or-name>] [--json]
  bb tasks folder list [--json]
  bb tasks folder update <id-or-name> [--name <name>] [--parent <id-or-name> | --no-parent] [--json]
  bb tasks folder delete <id-or-name> [--json]

Deleting a folder moves its projects and subfolders to the top level. No
tasks are deleted.`;

const CREATE_HELP =
  "Usage: bb tasks create [--project <prefix-or-id>] --title <title> [--description <markdown> | --description-file <path>] [--priority <priority>] [--label <name>]... [--due YYYY-MM-DD] [--parent <key-or-id>] [--attach <path>]... [--machine <id-or-name>] [--json]";
const LIST_HELP = `Usage: bb tasks list [--project <prefix-or-id>] [--status <status>]... [--priority <priority>]... [--label <name>]... [--active] [--search <query>] [--sort manual|priority|due] [--limit <1-${TASKS_PAGE_MAX_LIMIT}>] [--cursor <opaque>] [--json]`;
const SHOW_HELP = "Usage: bb tasks show <key-or-id> [--json]";
const UPDATE_HELP =
  "Usage: bb tasks update <key-or-id> [--status <status>] [--priority <priority>] [--title <title>] [--description <markdown> | --description-file <path>] [--due YYYY-MM-DD | --no-due] [--parent <key-or-id> | --no-parent] [--add-label <name>]... [--remove-label <name>]... [--machine <id-or-name>] [--json]";
const COMMENT_HELP =
  "Usage: bb tasks comment <key-or-id> (--body <markdown> | --body-file <path>) [--author <name>] [--machine <id-or-name>] [--notify] [--json]";
const LABEL_HELP = `Usage:
  bb tasks label create --project <prefix-or-id> --name <name> [--color <color>] [--json]
  bb tasks label list --project <prefix-or-id> [--json]
  bb tasks label delete --project <prefix-or-id> <name-or-id> [--json]`;
const ATTACHMENT_HELP = `Usage:
  bb tasks attachment add <key-or-comment-id> --file <path> [--name <name>] [--machine <id-or-name>] [--json]
  bb tasks attachment get <attachment-id> --out <path> [--machine <id-or-name>] [--json]
  bb tasks attachment list <key> [--json]
  bb tasks attachment remove <attachment-id> [--remove-references] [--json]

File paths are read from and written to the invoking machine: the thread's
machine when run inside an agent thread, otherwise the server's machine.
Pass --machine to target another enrolled machine explicitly.`;
const PRESET_HELP = `Usage:
  bb tasks preset list [--json]
  bb tasks preset show <name-or-id> [--json]
  bb tasks preset create --name <name> --provider <id> --model <id> --reasoning <level> --permission <accept-edits|auto|full> [--service-tier default|fast|none] [--environment project-default|worktree] [--base-branch <branch>] [--machine <id-or-name>] [--instructions <text>] [--json]
  bb tasks preset update <name-or-id> [--name <name>] [--provider <id>] [--model <id>] [--reasoning <level>] [--permission <accept-edits|auto|full>] [--service-tier default|fast|none] [--environment project-default|worktree] [--base-branch <branch>] [--machine <id-or-name>] [--instructions <text>] [--json]
  bb tasks preset delete <name-or-id> [--json]`;
const DISPATCH_HELP =
  "Usage: bb tasks dispatch <key> --preset <name> [--instructions <extra>] [--json]";
const ATTACH_HELP =
  "Usage: bb tasks attach <key> [--thread <thread-id>] [--json]";
const DETACH_HELP =
  "Usage: bb tasks detach <key> [--thread <thread-id>] [--json]";
const THREADS_HELP = "Usage: bb tasks threads <key> [--json]";

interface PluginStatus {
  name: string;
  version: string;
}

type TasksDomain = ReturnType<typeof registerHandlers>;
type ListTasksInput = Parameters<TasksDomain["listTasks"]>[0];

function normalizePrefix(value: string): string {
  return value.trim().toUpperCase();
}

function unwrapTask(result: TaskMutationResult): Task {
  if (!result.ok) throw new CliError(result.error.message);
  return result.task;
}

async function resolveClientHostId(
  bb: BbPluginApi,
  domain: TasksDomain,
  args: ParsedArgs,
  ctx: PluginCliContext,
): Promise<string | undefined> {
  const machine = option(args, "machine");
  if (machine !== undefined) return resolveMachineId(domain, machine);
  if (!ctx.threadId) return undefined;
  const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
  if (!thread.environmentId) return undefined;
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return environment.hostId;
}

function isMissingClientFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b|does not exist|not found|is a directory/i.test(message);
}

async function readClientFile(
  bb: BbPluginApi,
  hostId: string | undefined,
  path: string,
): Promise<{ bytes: Buffer; text: string | null }> {
  const file = await bb.sdk.files.read({
    ...(hostId ? { hostId } : {}),
    path,
  });
  return {
    bytes: Buffer.from(
      file.content,
      file.contentEncoding === "base64" ? "base64" : "utf8",
    ),
    text: file.contentEncoding === "utf8" ? file.content : null,
  };
}

async function readAttachmentSource(
  bb: BbPluginApi,
  hostId: string | undefined,
  path: string,
): Promise<Buffer> {
  try {
    return (await readClientFile(bb, hostId, path)).bytes;
  } catch (error) {
    if (isMissingClientFileError(error)) {
      throw new CliError(`attachment source is not a file: ${path}`);
    }
    throw error;
  }
}

async function writeClientFile(
  bb: BbPluginApi,
  hostId: string | undefined,
  path: string,
  content: Buffer,
): Promise<void> {
  await bb.sdk.files.write({
    ...(hostId ? { hostId } : {}),
    path,
    content: content.toString("base64"),
    contentEncoding: "base64",
    createParents: true,
  });
}

function attachmentFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || "attachment";
}

async function readFileOption(
  bb: BbPluginApi,
  args: ParsedArgs,
  ctx: PluginCliContext,
  hostId: string | undefined,
  inlineName: string,
  fileName: string,
): Promise<string | undefined> {
  const inline = option(args, inlineName);
  const file = option(args, fileName);
  if (inline !== undefined && file !== undefined) {
    throw new CliError(`--${inlineName} and --${fileName} cannot be combined`);
  }
  if (file === undefined) return inline;
  const path = resolve(ctx.cwd ?? process.cwd(), file);
  try {
    const { text } = await readClientFile(bb, hostId, path);
    if (text === null) {
      throw new CliError(`could not read ${file}: file is not UTF-8 text`);
    }
    return text;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`could not read ${file}: ${message}`);
  }
}

function validateSingleFlagChoice(
  optionValue: string | undefined,
  flagSet: boolean,
  optionName: string,
  flagName: string,
): void {
  if (optionValue !== undefined && flagSet) {
    throw new CliError(`--${optionName} and --${flagName} cannot be combined`);
  }
}

function derivePrefix(name: string, projects: readonly Project[]): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (!base || !/^[A-Z]/u.test(base)) base = `P${base}`;
  base = base.slice(0, 10);
  const used = new Set(projects.map((project) => project.prefix));
  if (!used.has(base)) return base;
  for (let number = 2; number < 10_000; number += 1) {
    const suffix = String(number);
    const candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new CliError(`could not derive a unique prefix from ${name}`);
}

async function listProjects(domain: TasksDomain): Promise<Project[]> {
  return tasksRpcContract.listProjects.output.parse(
    await domain.listProjects(tasksRpcContract.listProjects.input.parse({})),
  ).projects;
}

async function resolveProject(
  domain: TasksDomain,
  address: string,
): Promise<Project> {
  const normalized = address.trim().toUpperCase();
  const projects = await listProjects(domain);
  const project = projects.find(
    (candidate) =>
      candidate.id === normalized || candidate.prefix === normalized,
  );
  if (!project) throw new CliError(`project not found: ${address}`);
  return project;
}

async function defaultProject(
  domain: TasksDomain,
  ctx: PluginCliContext,
  required: boolean,
): Promise<Project | undefined> {
  if (!ctx.projectId) {
    if (required) {
      throw new CliError(
        "missing --project and no BB project context is available",
      );
    }
    return undefined;
  }
  const matches = (await listProjects(domain)).filter(
    (project) => project.linkedBbProjectId === ctx.projectId,
  );
  if (matches.length === 0) {
    throw new CliError(
      `no tracker project is linked to BB project ${ctx.projectId}; pass --project or link one with bb tasks project update`,
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      `multiple tracker projects are linked to BB project ${ctx.projectId}; pass --project explicitly`,
    );
  }
  return matches[0];
}

async function selectedProject(
  domain: TasksDomain,
  ctx: PluginCliContext,
  address: string | undefined,
  required: boolean,
): Promise<Project | undefined> {
  return address
    ? resolveProject(domain, address)
    : defaultProject(domain, ctx, required);
}

async function resolveFolder(
  domain: TasksDomain,
  address: string,
): Promise<Folder> {
  const folders = tasksRpcContract.listFolders.output.parse(
    await domain.listFolders(tasksRpcContract.listFolders.input.parse(null)),
  ).folders;
  const normalizedId = address.trim().toUpperCase();
  const byId = folders.find((folder) => folder.id === normalizedId);
  if (byId) return byId;
  const byName = folders.filter(
    (folder) => folder.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (byName.length === 0) throw new CliError(`folder not found: ${address}`);
  if (byName.length > 1) {
    throw new CliError(`folder name is ambiguous; use its id: ${address}`);
  }
  return byName[0]!;
}

async function resolveTask(
  domain: TasksDomain,
  address: string,
): Promise<Task> {
  const normalized = address.trim().toUpperCase();
  if (ULID_PATTERN.test(normalized)) {
    const result = tasksRpcContract.getTask.output.parse(
      await domain.getTask(
        tasksRpcContract.getTask.input.parse({ taskId: normalized }),
      ),
    );
    if (!result.task) throw new CliError(`task not found: ${address}`);
    return result.task;
  }
  if (!TASK_KEY_PATTERN.test(normalized)) {
    throw new CliError(`task not found: ${address}`);
  }
  const result = tasksRpcContract.getTaskByKey.output.parse(
    await domain.getTaskByKey(
      tasksRpcContract.getTaskByKey.input.parse({ taskKey: normalized }),
    ),
  );
  if (!result.task) throw new CliError(`task not found: ${address}`);
  return result.task;
}

async function listAllTasks(
  domain: TasksDomain,
  input: ListTasksInput,
): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor = input.cursor;
  do {
    const page = tasksRpcContract.listTasks.output.parse(
      await domain.listTasks(
        tasksRpcContract.listTasks.input.parse({
          ...input,
          limit: TASKS_PAGE_MAX_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    );
    tasks.push(...page.tasks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return tasks;
}

function taskPageLimit(args: ParsedArgs): number {
  const raw = option(args, "limit");
  if (raw === undefined) return TASKS_PAGE_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > TASKS_PAGE_MAX_LIMIT) {
    throw new CliError(
      `--limit must be an integer from 1 to ${TASKS_PAGE_MAX_LIMIT}`,
    );
  }
  return limit;
}

function resolvePreset(presets: readonly Preset[], address: string): Preset {
  const normalized = address.trim().toLowerCase();
  const matches = presets.filter(
    (preset) =>
      preset.id.toLowerCase() === normalized ||
      preset.name.toLowerCase() === normalized,
  );
  if (matches.length === 0) throw new CliError(`preset not found: ${address}`);
  if (matches.length > 1) {
    throw new CliError(`preset name is ambiguous; use its id: ${address}`);
  }
  return matches[0]!;
}

async function listPresets(domain: TasksDomain): Promise<Preset[]> {
  return tasksRpcContract.listPresets.output.parse(
    await domain.listPresets(tasksRpcContract.listPresets.input.parse(null)),
  ).presets;
}

function parsePresetEnvironment(
  value: string | undefined,
  fallback: Preset["environmentKind"],
): Preset["environmentKind"] {
  if (value === undefined) return fallback;
  if (value === "project-default") return "project-default";
  if (value === "worktree") return "new-worktree";
  throw new CliError(
    `invalid --environment ${value}; expected project-default or worktree`,
  );
}

function parsePresetServiceTier(
  value: string | undefined,
): "default" | "fast" | null | undefined {
  if (value === undefined) return undefined;
  if (value === "default" || value === "fast") return value;
  if (value === "none") return null;
  throw new CliError(
    `invalid --service-tier ${value}; expected default, fast, or none`,
  );
}

async function resolveMachineId(
  domain: TasksDomain,
  address: string,
): Promise<string> {
  const machines = tasksRpcContract.listMachines.output.parse(
    await domain.listMachines(tasksRpcContract.listMachines.input.parse({})),
  ).machines;
  const normalized = address.trim().toLocaleLowerCase();
  const matches = machines.filter(
    (machine) =>
      machine.id === address.trim() ||
      machine.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new CliError(`machine not found: ${address}`);
  }
  if (matches.length > 1) {
    throw new CliError(`machine name is ambiguous; use its id: ${address}`);
  }
  return matches[0]!.id;
}

function validatePresetTargetOptions(input: {
  environmentKind: Preset["environmentKind"];
  baseBranch: string | undefined;
  machine: string | undefined;
}): void {
  if (input.environmentKind === "new-worktree") return;
  if (input.baseBranch !== undefined) {
    throw new CliError("--base-branch requires --environment worktree");
  }
  if (input.machine !== undefined) {
    throw new CliError("--machine requires --environment worktree");
  }
}

async function projectLabels(
  domain: TasksDomain,
  projectId: string,
): Promise<Label[]> {
  return tasksRpcContract.listLabels.output.parse(
    await domain.listLabels(
      tasksRpcContract.listLabels.input.parse({ projectId }),
    ),
  ).labels;
}

function resolveLabel(labels: readonly Label[], address: string): Label {
  const normalizedId = address.trim().toUpperCase();
  const label = labels.find(
    (candidate) =>
      candidate.id === normalizedId ||
      candidate.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (!label) throw new CliError(`label not found: ${address}`);
  return label;
}

function projectTable(
  projects: readonly Project[],
  folders: readonly Folder[],
) {
  const folderNames = new Map(
    folders.map((folder) => [folder.id, folder.name]),
  );
  return table(
    ["PREFIX", "NAME", "FOLDER", "BB PROJECT", "ID"],
    projects.map((project) => [
      project.prefix,
      project.name,
      project.folderId
        ? (folderNames.get(project.folderId) ?? project.folderId)
        : "-",
      project.linkedBbProjectId ?? "-",
      project.id,
    ]),
    "No projects.",
  );
}

function taskAuthor(ctx: PluginCliContext): string {
  return ctx.threadId ? `agent (${ctx.threadId})` : "cli";
}

async function runProject(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  argv: string[],
): Promise<string> {
  const [action, ...rest] = argv;
  if (!action || action === "--help") return PROJECT_HELP;
  const args = parseArgs(rest);
  if (args.flags.has("help")) return PROJECT_HELP;

  if (action === "create") {
    assertAllowed(args, [
      "name",
      "prefix",
      "folder",
      "link-bb-project",
      "color",
    ]);
    requirePositionals(args, 0, PROJECT_HELP.split("\n")[1]!.trim());
    const name = requireOption(args, "name");
    const projects = await listProjects(domain);
    const folderAddress = option(args, "folder");
    const folder = folderAddress
      ? await resolveFolder(domain, folderAddress)
      : undefined;
    const result = tasksRpcContract.createProject.output.parse(
      await domain.createProject(
        tasksRpcContract.createProject.input.parse({
          name,
          prefix: option(args, "prefix")
            ? normalizePrefix(requireOption(args, "prefix"))
            : derivePrefix(name, projects),
          color: option(args, "color") ?? DEFAULT_PROJECT_COLOR,
          folderId: folder?.id ?? null,
          linkedBbProjectId: option(args, "link-bb-project") ?? null,
        }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify(result)
      : `Created project ${result.project.prefix}  ${result.project.name}`;
  }

  if (action === "list") {
    assertAllowed(args, []);
    requirePositionals(args, 0, "bb tasks project list [--json]");
    const projects = await listProjects(domain);
    const folders = tasksRpcContract.listFolders.output.parse(
      await domain.listFolders(tasksRpcContract.listFolders.input.parse(null)),
    ).folders;
    return args.flags.has("json")
      ? JSON.stringify({ projects })
      : projectTable(projects, folders);
  }

  if (action === "show") {
    assertAllowed(args, []);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks project show <prefix-or-id> [--json]",
    );
    const project = await resolveProject(domain, address!);
    const folder = project.folderId
      ? await resolveFolder(domain, project.folderId)
      : null;
    if (args.flags.has("json")) return JSON.stringify({ project, folder });
    return detail([
      ["Project", `${project.prefix} — ${project.name}`],
      ["ID", project.id],
      ["Color", project.color],
      ["Folder", folder?.name ?? "-"],
      ["BB project", project.linkedBbProjectId ?? "-"],
      ["Next task", `${project.prefix}-${project.nextTaskNumber}`],
      ["Created", project.createdAt],
    ]);
  }

  if (action === "update") {
    assertAllowed(
      args,
      ["name", "color", "folder", "link-bb-project", "rename-prefix"],
      ["no-folder", "unlink-bb-project"],
    );
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks project update <prefix-or-id> [options] [--json]",
    );
    const project = await resolveProject(domain, address!);
    const folderAddress = option(args, "folder");
    const linkedBbProjectId = option(args, "link-bb-project");
    validateSingleFlagChoice(
      folderAddress,
      args.flags.has("no-folder"),
      "folder",
      "no-folder",
    );
    validateSingleFlagChoice(
      linkedBbProjectId,
      args.flags.has("unlink-bb-project"),
      "link-bb-project",
      "unlink-bb-project",
    );
    const folder = folderAddress
      ? await resolveFolder(domain, folderAddress)
      : undefined;
    const changes = {
      name: option(args, "name"),
      color: option(args, "color"),
      folderId: args.flags.has("no-folder") ? null : folder?.id,
      linkedBbProjectId: args.flags.has("unlink-bb-project")
        ? null
        : linkedBbProjectId,
    };
    const renamePrefix = option(args, "rename-prefix");
    if (
      renamePrefix === undefined &&
      changes.name === undefined &&
      changes.color === undefined &&
      changes.folderId === undefined &&
      changes.linkedBbProjectId === undefined
    ) {
      throw new CliError("no project changes were provided");
    }
    const renameInput =
      renamePrefix === undefined
        ? undefined
        : tasksRpcContract.renameProjectPrefix.input.parse({
            projectId: project.id,
            prefix: normalizePrefix(renamePrefix),
          });
    const hasFieldChanges =
      changes.name !== undefined ||
      changes.color !== undefined ||
      changes.folderId !== undefined ||
      changes.linkedBbProjectId !== undefined;
    const updateInput = hasFieldChanges
      ? tasksRpcContract.updateProject.input.parse({
          projectId: project.id,
          ...changes,
        })
      : undefined;
    if (
      renameInput &&
      store.projectPrefixExists(renameInput.prefix, project.id)
    ) {
      throw new CliError(
        `Project prefix is already in use: ${renameInput.prefix}`,
      );
    }
    const updated = store.transaction(() =>
      store.tasks.updateProject(project.id, {
        prefix: renameInput?.prefix,
        name: updateInput?.name,
        color: updateInput?.color,
        folderId: updateInput?.folderId,
        linkedBbProjectId: updateInput?.linkedBbProjectId,
      }),
    );
    publishProjectsChanged(bb, updated.id);
    return args.flags.has("json")
      ? JSON.stringify({ project: updated })
      : `Updated project ${updated.prefix}  ${updated.name}`;
  }

  throw new CliError(`unknown project subcommand: ${action}`);
}

async function runFolder(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  argv: string[],
): Promise<string> {
  const [action, ...rest] = argv;
  if (!action || action === "--help") return FOLDER_HELP;
  const args = parseArgs(rest);
  if (args.flags.has("help")) return FOLDER_HELP;

  if (action === "create") {
    assertAllowed(args, ["name", "parent"]);
    requirePositionals(
      args,
      0,
      "bb tasks folder create --name <name> [options]",
    );
    const parentAddress = option(args, "parent");
    const parent = parentAddress
      ? await resolveFolder(domain, parentAddress)
      : undefined;
    const result = tasksRpcContract.createFolder.output.parse(
      await domain.createFolder(
        tasksRpcContract.createFolder.input.parse({
          name: requireOption(args, "name"),
          parentFolderId: parent?.id ?? null,
        }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify(result)
      : `Created folder ${result.folder.name}  ${result.folder.id}`;
  }

  if (action === "list") {
    assertAllowed(args, []);
    requirePositionals(args, 0, "bb tasks folder list [--json]");
    const result = tasksRpcContract.listFolders.output.parse(
      await domain.listFolders(tasksRpcContract.listFolders.input.parse(null)),
    );
    const names = new Map(
      result.folders.map((folder) => [folder.id, folder.name]),
    );
    return args.flags.has("json")
      ? JSON.stringify(result)
      : table(
          ["NAME", "PARENT", "ID"],
          result.folders.map((folder) => [
            folder.name,
            folder.parentFolderId
              ? (names.get(folder.parentFolderId) ?? folder.parentFolderId)
              : "-",
            folder.id,
          ]),
          "No folders.",
        );
  }

  if (action === "update") {
    assertAllowed(args, ["name", "parent"], ["no-parent"]);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks folder update <id-or-name> [options] [--json]",
    );
    const folder = await resolveFolder(domain, address!);
    const parentAddress = option(args, "parent");
    validateSingleFlagChoice(
      parentAddress,
      args.flags.has("no-parent"),
      "parent",
      "no-parent",
    );
    if (
      option(args, "name") === undefined &&
      parentAddress === undefined &&
      !args.flags.has("no-parent")
    ) {
      throw new CliError("no folder changes were provided");
    }
    const name = option(args, "name");
    const parent = parentAddress
      ? await resolveFolder(domain, parentAddress)
      : null;
    const renameInput =
      name === undefined
        ? undefined
        : tasksRpcContract.renameFolder.input.parse({
            folderId: folder.id,
            name,
          });
    const moveInput =
      parentAddress === undefined && !args.flags.has("no-parent")
        ? undefined
        : tasksRpcContract.moveFolder.input.parse({
            folderId: folder.id,
            parentFolderId: parent?.id ?? null,
          });
    const updated = store.transaction(() =>
      store.tasks.updateFolder(folder.id, {
        name: renameInput?.name,
        parentFolderId: moveInput?.parentFolderId,
      }),
    );
    publishProjectsChanged(bb, null);
    return args.flags.has("json")
      ? JSON.stringify({ folder: updated })
      : `Updated folder ${updated.name}  ${updated.id}`;
  }

  if (action === "delete") {
    assertAllowed(args, []);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks folder delete <id-or-name> [--json]",
    );
    const folder = await resolveFolder(domain, address!);
    const result = tasksRpcContract.deleteFolder.output.parse(
      await domain.deleteFolder(
        tasksRpcContract.deleteFolder.input.parse({ folderId: folder.id }),
      ),
    );
    if (!result.deleted) {
      throw new CliError(
        `folder not found: ${address} (it was deleted by another client)`,
      );
    }
    if (args.flags.has("json")) {
      return JSON.stringify({ ...result, folder });
    }
    const projectCount = result.movedProjectIds.length;
    const folderCount = result.movedFolderIds.length;
    const moved = [
      projectCount > 0
        ? `${projectCount} project${projectCount > 1 ? "s" : ""}`
        : null,
      folderCount > 0
        ? `${folderCount} subfolder${folderCount > 1 ? "s" : ""}`
        : null,
    ].filter((part) => part !== null);
    return moved.length === 0
      ? `Deleted folder ${folder.name}`
      : `Deleted folder ${folder.name}; ${moved.join(" and ")} moved to the top level. No tasks were deleted.`;
  }

  throw new CliError(`unknown folder subcommand: ${action}`);
}

async function runCreate(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string | PluginCliResult> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return CREATE_HELP;
  assertAllowed(args, [
    "project",
    "title",
    "description",
    "description-file",
    "priority",
    "label",
    "due",
    "parent",
    "attach",
    "machine",
  ]);
  requirePositionals(args, 0, CREATE_HELP);
  const attachPaths = options(args, "attach").map((path) =>
    resolve(ctx.cwd ?? process.cwd(), path),
  );
  const usesClientFiles =
    attachPaths.length > 0 || option(args, "description-file") !== undefined;
  if (option(args, "machine") !== undefined && !usesClientFiles) {
    throw new CliError("--machine requires --attach or --description-file");
  }
  const clientHostId = usesClientFiles
    ? await resolveClientHostId(bb, domain, args, ctx)
    : undefined;
  const attachSources: Array<{ path: string; bytes: Buffer }> = [];
  for (const path of attachPaths) {
    attachSources.push({
      path,
      bytes: await readAttachmentSource(bb, clientHostId, path),
    });
  }
  const project = await selectedProject(
    domain,
    ctx,
    option(args, "project"),
    true,
  );
  if (!project) throw new CliError("project is required");
  const labels = await projectLabels(domain, project.id);
  const labelIds = options(args, "label").map(
    (name) => resolveLabel(labels, name).id,
  );
  const parentAddress = option(args, "parent");
  const parent = parentAddress
    ? await resolveTask(domain, parentAddress)
    : undefined;
  const input = tasksRpcContract.createTask.input.parse({
    projectId: project.id,
    title: requireOption(args, "title"),
    description:
      (await readFileOption(
        bb,
        args,
        ctx,
        clientHostId,
        "description",
        "description-file",
      )) ?? "",
    priority: option(args, "priority") ?? "none",
    dueDate: option(args, "due") ?? null,
    parentTaskId: parent?.id ?? null,
    labelIds,
  });
  const task = unwrapTask(
    tasksRpcContract.createTask.output.parse(await domain.createTask(input)),
  );
  const attachments: Attachment[] = [];
  const failedAttachments: Array<{ path: string; error: string }> = [];
  for (const source of attachSources) {
    try {
      const attachment = await saveAttachmentFromBytes(
        store.tasks,
        source.bytes,
        {
          taskId: task.id,
          fileName: attachmentFileName(source.path),
        },
      );
      publishAttachmentChanged(bb, store.tasks, attachment);
      attachments.push(attachment);
    } catch (error) {
      failedAttachments.push({
        path: source.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const stdout = args.flags.has("json")
    ? JSON.stringify({ task, attachments, failedAttachments })
    : [
        `Created ${task.key}  ${task.title}`,
        ...attachments.map(
          (attachment) => `Attached ${attachment.fileName}  ${attachment.id}`,
        ),
        ...failedAttachments.map(
          (failure) => `Failed to attach ${failure.path}: ${failure.error}`,
        ),
        ...(failedAttachments.length > 0
          ? failedAttachments.map(
              (failure) =>
                `Retry with: bb tasks attachment add ${task.key} --file ${failure.path}`,
            )
          : []),
      ].join("\n");
  if (failedAttachments.length === 0) return stdout;
  return {
    exitCode: 1,
    stdout,
    stderr: `created ${task.key}, but ${failedAttachments.length} of ${attachPaths.length} attachments failed; see stdout for per-file recovery commands`,
  };
}

async function labelsForTaskList(
  domain: TasksDomain,
  projects: readonly Project[],
): Promise<Map<string, Label>> {
  const labels = new Map<string, Label>();
  for (const project of projects) {
    for (const label of await projectLabels(domain, project.id)) {
      labels.set(label.id, label);
    }
  }
  return labels;
}

async function runList(
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return LIST_HELP;
  assertAllowed(
    args,
    [
      "project",
      "status",
      "priority",
      "label",
      "search",
      "sort",
      "limit",
      "cursor",
    ],
    ["active"],
  );
  requirePositionals(args, 0, LIST_HELP);
  const sortOption = option(args, "sort") ?? "manual";
  const sort = TASK_SORTS.find((candidate) => candidate === sortOption);
  if (sort === undefined) {
    throw new CliError(
      `invalid sort: ${sortOption} (${TASK_SORTS.join(", ")})`,
    );
  }
  const project = await selectedProject(
    domain,
    ctx,
    option(args, "project"),
    false,
  );
  const projects = project ? [project] : await listProjects(domain);
  const labelById = await labelsForTaskList(domain, projects);
  const requestedLabels = options(args, "label");
  const labelIds = requestedLabels.map((name) => {
    const matches = [...labelById.values()].filter(
      (label) => label.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (matches.length === 0) throw new CliError(`label not found: ${name}`);
    if (matches.length > 1 && !project) {
      throw new CliError(
        `label name exists in multiple projects; pass --project: ${name}`,
      );
    }
    return matches[0]!.id;
  });
  const result = tasksRpcContract.listTasks.output.parse(
    await domain.listTasks(
      tasksRpcContract.listTasks.input.parse({
        projectId: project?.id,
        statuses:
          options(args, "status").length > 0
            ? options(args, "status")
            : undefined,
        priorities:
          options(args, "priority").length > 0
            ? options(args, "priority")
            : undefined,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        activeOnly: args.flags.has("active"),
        search: option(args, "search"),
        sort,
        limit: taskPageLimit(args),
        cursor: option(args, "cursor"),
      }),
    ),
  );
  const tasks = [];
  for (const task of result.tasks) {
    const threadResult = tasksRpcContract.listTaskThreads.output.parse(
      await domain.listTaskThreads(
        tasksRpcContract.listTaskThreads.input.parse({ taskId: task.id }),
      ),
    );
    tasks.push({
      ...task,
      labels: task.labelIds.map((id) => labelById.get(id)?.name ?? id),
      agentsWorking: threadResult.taskThreads.filter((thread) =>
        ACTIVE_THREAD_STATUSES.has(thread.liveStatus),
      ).length,
    });
  }
  const limit = taskPageLimit(args);
  if (args.flags.has("json")) {
    return JSON.stringify({ tasks, nextCursor: result.nextCursor, limit });
  }
  const output = table(
    ["KEY", "STATUS", "PRIORITY", "DUE", "TITLE", "LABELS", "AGENTS"],
    tasks.map((task) => [
      task.key,
      task.status,
      task.priority,
      task.dueDate ?? "-",
      task.title,
      task.labels.join(", ") || "-",
      task.agentsWorking,
    ]),
    "No tasks.",
  );
  return result.nextCursor === null
    ? output
    : `${output}\n\nMore results are available. Re-run with the same filters and add: --limit ${limit} --cursor ${result.nextCursor}`;
}

async function runShow(domain: TasksDomain, argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return SHOW_HELP;
  assertAllowed(args, []);
  const [address] = requirePositionals(args, 1, SHOW_HELP);
  const task = await resolveTask(domain, address!);
  const project = await resolveProject(domain, task.projectId);
  const allLabels = await projectLabels(domain, project.id);
  const labelById = new Map(allLabels.map((label) => [label.id, label]));
  const labels = task.labelIds.map((id) => labelById.get(id)!).filter(Boolean);
  const subtasks = await listAllTasks(
    domain,
    tasksRpcContract.listTasks.input.parse({ parentTaskId: task.id }),
  );
  const comments = tasksRpcContract.listComments.output.parse(
    await domain.listComments(
      tasksRpcContract.listComments.input.parse({ taskId: task.id }),
    ),
  ).comments;
  const directAttachments = tasksRpcContract.listAttachments.output.parse(
    await domain.listAttachments(
      tasksRpcContract.listAttachments.input.parse({ taskId: task.id }),
    ),
  ).attachments;
  const commentAttachments = [];
  for (const comment of comments) {
    commentAttachments.push(
      ...tasksRpcContract.listAttachments.output.parse(
        await domain.listAttachments(
          tasksRpcContract.listAttachments.input.parse({
            commentId: comment.id,
          }),
        ),
      ).attachments,
    );
  }
  const attachments = [...directAttachments, ...commentAttachments];
  const taskThreads = tasksRpcContract.listTaskThreads.output.parse(
    await domain.listTaskThreads(
      tasksRpcContract.listTaskThreads.input.parse({ taskId: task.id }),
    ),
  ).taskThreads;
  const { pullRequests, unavailableThreadIds } =
    tasksRpcContract.listTaskPullRequests.output.parse(
      await domain.listTaskPullRequests(
        tasksRpcContract.listTaskPullRequests.input.parse({ taskId: task.id }),
      ),
    );
  const payload = {
    task,
    project,
    labels,
    subtasks,
    attachments,
    taskThreads,
    pullRequests,
    pullRequestUnavailableThreadIds: unavailableThreadIds,
    comments,
  };
  if (args.flags.has("json")) return JSON.stringify(payload);

  const sections = [
    detail([
      ["Task", `${task.key} — ${task.title}`],
      ["ID", task.id],
      ["Project", `${project.prefix} — ${project.name}`],
      ["Status", task.status],
      ["Priority", task.priority],
      ["Due", task.dueDate ?? "-"],
      ["Parent", task.parentTaskId ?? "-"],
      ["Labels", labels.map((label) => label.name).join(", ") || "-"],
      ["Created", task.createdAt],
      ["Updated", task.updatedAt],
    ]),
    `Description\n${task.description || "(none)"}`,
    `Sub-tasks\n${table(
      ["KEY", "STATUS", "PRIORITY", "TITLE"],
      subtasks.map((subtask) => [
        subtask.key,
        subtask.status,
        subtask.priority,
        subtask.title,
      ]),
      "(none)",
    )}`,
    `Attachments\n${table(
      ["ID", "NAME", "SIZE"],
      attachments.map((attachment) => [
        attachment.id,
        attachment.fileName,
        bytes(attachment.sizeBytes),
      ]),
      "(none)",
    )}`,
    `Attached threads\n${table(
      ["THREAD", "STATUS", "PRESET", "TITLE"],
      taskThreads.map((thread) => [
        thread.threadId,
        thread.liveStatus,
        thread.presetName,
        thread.title,
      ]),
      "(none)",
    )}`,
    `Pull requests\n${table(
      ["PR", "STATE", "TITLE", "URL"],
      pullRequests.map((pullRequest) => [
        `#${pullRequest.number}`,
        pullRequest.state,
        pullRequest.title,
        pullRequest.url,
      ]),
      "(none)",
    )}${
      unavailableThreadIds.length > 0
        ? `\nPR lookup unavailable for: ${unavailableThreadIds.join(", ")}`
        : ""
    }`,
    `Comments\n${table(
      ["TIME", "KIND", "AUTHOR", "PROVIDER", "BODY"],
      comments.map((comment) => [
        comment.createdAt,
        comment.kind,
        comment.threadTitle ?? comment.authorName,
        comment.provider?.name ?? "-",
        comment.body,
      ]),
      "(none)",
    )}`,
  ];
  return sections.join("\n\n");
}

async function runUpdate(
  bb: BbPluginApi,
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return UPDATE_HELP;
  assertAllowed(
    args,
    [
      "status",
      "priority",
      "title",
      "description",
      "description-file",
      "due",
      "parent",
      "add-label",
      "remove-label",
      "machine",
    ],
    ["no-due", "no-parent"],
  );
  const [address] = requirePositionals(args, 1, UPDATE_HELP);
  const task = await resolveTask(domain, address!);
  const dueDate = option(args, "due");
  validateSingleFlagChoice(dueDate, args.flags.has("no-due"), "due", "no-due");
  const parentAddress = option(args, "parent");
  validateSingleFlagChoice(
    parentAddress,
    args.flags.has("no-parent"),
    "parent",
    "no-parent",
  );
  const parent =
    parentAddress === undefined
      ? undefined
      : await resolveTask(domain, parentAddress);
  if (
    option(args, "machine") !== undefined &&
    option(args, "description-file") === undefined
  ) {
    throw new CliError("--machine requires --description-file");
  }
  const clientHostId =
    option(args, "description-file") !== undefined
      ? await resolveClientHostId(bb, domain, args, ctx)
      : undefined;
  const description = await readFileOption(
    bb,
    args,
    ctx,
    clientHostId,
    "description",
    "description-file",
  );
  const labels = await projectLabels(domain, task.projectId);
  const nextLabels = new Set(task.labelIds);
  for (const name of options(args, "add-label")) {
    nextLabels.add(resolveLabel(labels, name).id);
  }
  for (const name of options(args, "remove-label")) {
    nextLabels.delete(resolveLabel(labels, name).id);
  }
  const labelsChanged =
    options(args, "add-label").length > 0 ||
    options(args, "remove-label").length > 0;
  if (
    option(args, "status") === undefined &&
    option(args, "priority") === undefined &&
    option(args, "title") === undefined &&
    description === undefined &&
    dueDate === undefined &&
    !args.flags.has("no-due") &&
    parentAddress === undefined &&
    !args.flags.has("no-parent") &&
    !labelsChanged
  ) {
    throw new CliError("no task changes were provided");
  }
  const result = tasksRpcContract.updateTask.output.parse(
    await domain.updateTask(
      tasksRpcContract.updateTask.input.parse({
        taskId: task.id,
        status: option(args, "status"),
        priority: option(args, "priority"),
        title: option(args, "title"),
        description,
        dueDate: args.flags.has("no-due") ? null : dueDate,
        parentTaskId:
          parentAddress === undefined && !args.flags.has("no-parent")
            ? undefined
            : (parent?.id ?? null),
        labelIds: labelsChanged ? [...nextLabels] : undefined,
        authorName: taskAuthor(ctx),
      }),
    ),
  );
  const updated = unwrapTask(result);
  return args.flags.has("json")
    ? JSON.stringify({ task: updated })
    : `Updated ${updated.key}  ${updated.title}`;
}

async function runComment(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return COMMENT_HELP;
  assertAllowed(args, ["body", "body-file", "author", "machine"], ["notify"]);
  const [address] = requirePositionals(args, 1, COMMENT_HELP);
  const task = await resolveTask(domain, address!);
  if (
    option(args, "machine") !== undefined &&
    option(args, "body-file") === undefined
  ) {
    throw new CliError("--machine requires --body-file");
  }
  const clientHostId =
    option(args, "body-file") !== undefined
      ? await resolveClientHostId(bb, domain, args, ctx)
      : undefined;
  const body = await readFileOption(
    bb,
    args,
    ctx,
    clientHostId,
    "body",
    "body-file",
  );
  if (body === undefined)
    throw new CliError("missing required --body or --body-file");
  if (!body.trim()) throw new CliError("comment body must not be blank");
  const comment = await createComment(bb, store, {
    taskId: task.id,
    kind: ctx.threadId ? "agent" : "user",
    authorName: option(args, "author") ?? taskAuthor(ctx),
    presetName: null,
    threadId: ctx.threadId ?? null,
    body,
    notify: args.flags.has("notify"),
  });
  return args.flags.has("json")
    ? JSON.stringify({ comment })
    : `Commented on ${task.key}  ${comment.id}`;
}

async function runLabel(domain: TasksDomain, argv: string[]): Promise<string> {
  const [action, ...rest] = argv;
  if (!action || action === "--help") return LABEL_HELP;
  const args = parseArgs(rest);
  if (args.flags.has("help")) return LABEL_HELP;

  if (action === "create") {
    assertAllowed(args, ["project", "name", "color"]);
    requirePositionals(
      args,
      0,
      "bb tasks label create --project <project> --name <name>",
    );
    const project = await resolveProject(
      domain,
      requireOption(args, "project"),
    );
    const result = tasksRpcContract.createLabel.output.parse(
      await domain.createLabel(
        tasksRpcContract.createLabel.input.parse({
          projectId: project.id,
          name: requireOption(args, "name"),
          color: option(args, "color") ?? DEFAULT_LABEL_COLOR,
        }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify(result)
      : `Created label ${result.label.name}  ${result.label.id}`;
  }

  if (action === "list") {
    assertAllowed(args, ["project"]);
    requirePositionals(args, 0, "bb tasks label list --project <project>");
    const project = await resolveProject(
      domain,
      requireOption(args, "project"),
    );
    const labels = await projectLabels(domain, project.id);
    return args.flags.has("json")
      ? JSON.stringify({ labels })
      : table(
          ["NAME", "COLOR", "ID"],
          labels.map((label) => [label.name, label.color, label.id]),
          "No labels.",
        );
  }

  if (action === "delete") {
    assertAllowed(args, ["project"]);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks label delete --project <project> <name-or-id>",
    );
    const project = await resolveProject(
      domain,
      requireOption(args, "project"),
    );
    const label = resolveLabel(
      await projectLabels(domain, project.id),
      address!,
    );
    const result = tasksRpcContract.deleteLabel.output.parse(
      await domain.deleteLabel(
        tasksRpcContract.deleteLabel.input.parse({ labelId: label.id }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify({ ...result, label })
      : `Deleted label ${label.name}`;
  }

  throw new CliError(`unknown label subcommand: ${action}`);
}

async function runAttachment(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string> {
  const [action, ...rest] = argv;
  if (!action || action === "--help") return ATTACHMENT_HELP;
  const args = parseArgs(rest);
  if (args.flags.has("help")) return ATTACHMENT_HELP;

  if (action === "add") {
    assertAllowed(args, ["file", "name", "machine"]);
    const [ownerAddress] = requirePositionals(
      args,
      1,
      "bb tasks attachment add <key-or-comment-id> --file <path> [--name <name>] [--machine <id-or-name>] [--json]",
    );
    const sourceOption = requireOption(args, "file");
    const sourcePath = resolve(ctx.cwd ?? process.cwd(), sourceOption);
    const normalizedOwner = ownerAddress!.trim().toUpperCase();
    const comment = ULID_PATTERN.test(normalizedOwner)
      ? store.tasks.getComment(normalizedOwner)
      : undefined;
    if (ULID_PATTERN.test(normalizedOwner) && !comment) {
      throw new CliError(`comment not found: ${ownerAddress}`);
    }
    const owner = comment
      ? { commentId: comment.id }
      : { taskId: (await resolveTask(domain, ownerAddress!)).id };
    const clientHostId = await resolveClientHostId(bb, domain, args, ctx);
    const bytes = await readAttachmentSource(bb, clientHostId, sourcePath);
    const attachment = await saveAttachmentFromBytes(store.tasks, bytes, {
      ...owner,
      fileName: option(args, "name") ?? attachmentFileName(sourcePath),
    });
    publishAttachmentChanged(bb, store.tasks, attachment);
    const payload = {
      attachment,
      url: buildAttachmentUrl(attachment.id),
    };
    return args.flags.has("json")
      ? JSON.stringify(payload)
      : `Added attachment ${attachment.fileName}  ${attachment.id}`;
  }

  if (action === "get") {
    assertAllowed(args, ["out", "machine"]);
    const [attachmentId] = requirePositionals(
      args,
      1,
      "bb tasks attachment get <attachment-id> --out <path> [--machine <id-or-name>] [--json]",
    );
    const outOption = requireOption(args, "out");
    const outPath = resolve(ctx.cwd ?? process.cwd(), outOption);
    const clientHostId = await resolveClientHostId(bb, domain, args, ctx);
    const { attachment, content } = await readAttachmentContent(
      store.tasks,
      attachmentId!,
    );
    await writeClientFile(bb, clientHostId, outPath, content);
    return args.flags.has("json")
      ? JSON.stringify({ attachment, out: outPath })
      : `Saved ${attachment.fileName}  ${outPath}`;
  }

  if (action === "list") {
    assertAllowed(args, []);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks attachment list <key> [--json]",
    );
    const task = await resolveTask(domain, address!);
    const directAttachments = tasksRpcContract.listAttachments.output.parse(
      await domain.listAttachments(
        tasksRpcContract.listAttachments.input.parse({ taskId: task.id }),
      ),
    ).attachments;
    const comments = tasksRpcContract.listComments.output.parse(
      await domain.listComments(
        tasksRpcContract.listComments.input.parse({ taskId: task.id }),
      ),
    ).comments;
    const commentAttachments: Attachment[] = [];
    for (const comment of comments) {
      commentAttachments.push(
        ...tasksRpcContract.listAttachments.output.parse(
          await domain.listAttachments(
            tasksRpcContract.listAttachments.input.parse({
              commentId: comment.id,
            }),
          ),
        ).attachments,
      );
    }
    const attachments = [...directAttachments, ...commentAttachments];
    return args.flags.has("json")
      ? JSON.stringify({ task, attachments })
      : table(
          ["ID", "NAME", "TYPE", "SIZE"],
          attachments.map((attachment) => [
            attachment.id,
            attachment.fileName,
            attachment.mime,
            bytes(attachment.sizeBytes),
          ]),
          "No attachments.",
        );
  }

  if (action === "remove") {
    assertAllowed(args, [], ["remove-references"]);
    const [attachmentId] = requirePositionals(
      args,
      1,
      "bb tasks attachment remove <attachment-id> [--remove-references] [--json]",
    );
    const result = tasksRpcContract.deleteAttachment.output.parse(
      await domain.deleteAttachment(
        tasksRpcContract.deleteAttachment.input.parse({
          attachmentId: attachmentId!.trim(),
          removeDescriptionReferences: args.flags.has("remove-references"),
        }),
      ),
    );
    if (!result.ok) throw new CliError(result.error.message);
    if (!result.deleted) {
      throw new CliError(`attachment not found: ${attachmentId}`);
    }
    return args.flags.has("json")
      ? JSON.stringify({ deleted: true, attachment: result.attachment })
      : `Removed attachment ${result.attachment.fileName}  ${result.attachment.id}`;
  }

  throw new CliError(`unknown attachment subcommand: ${action}`);
}

async function runPreset(domain: TasksDomain, argv: string[]): Promise<string> {
  const [action, ...rest] = argv;
  if (!action || action === "--help") return PRESET_HELP;
  const args = parseArgs(rest);
  if (args.flags.has("help")) return PRESET_HELP;

  if (action === "list") {
    assertAllowed(args, []);
    requirePositionals(args, 0, "bb tasks preset list [--json]");
    const presets = await listPresets(domain);
    return args.flags.has("json")
      ? JSON.stringify({ presets })
      : table(
          [
            "NAME",
            "PROVIDER",
            "MODEL",
            "REASONING",
            "SERVICE TIER",
            "PERMISSION",
            "ENVIRONMENT",
            "BASE BRANCH",
            "MACHINE",
            "BUILTIN",
            "ID",
          ],
          presets.map((preset) => [
            preset.name,
            preset.providerId,
            preset.modelId,
            preset.reasoningLevel,
            preset.serviceTier ?? "-",
            preset.permissionMode,
            preset.environmentKind === "new-worktree"
              ? "worktree"
              : "project-default",
            preset.baseBranch ?? "-",
            preset.machineId ?? "-",
            preset.builtin ? "yes" : "no",
            preset.id,
          ]),
          "No presets.",
        );
  }

  if (action === "show") {
    assertAllowed(args, []);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks preset show <name-or-id> [--json]",
    );
    const preset = resolvePreset(await listPresets(domain), address!);
    return args.flags.has("json")
      ? JSON.stringify({ preset })
      : detail([
          ["Name", preset.name],
          ["Provider", preset.providerId],
          ["Model", preset.modelId],
          ["Reasoning", preset.reasoningLevel],
          ["Service tier", preset.serviceTier ?? "-"],
          ["Permission", preset.permissionMode],
          [
            "Environment",
            preset.environmentKind === "new-worktree"
              ? "worktree"
              : "project-default",
          ],
          ["Base branch", preset.baseBranch ?? "-"],
          ["Machine", preset.machineId ?? "-"],
          ["Instructions", preset.instructions || "-"],
          ["Built in", preset.builtin ? "yes" : "no"],
          ["ID", preset.id],
        ]);
  }

  if (action === "create") {
    assertAllowed(args, [
      "name",
      "provider",
      "model",
      "reasoning",
      "service-tier",
      "permission",
      "environment",
      "base-branch",
      "machine",
      "instructions",
    ]);
    requirePositionals(args, 0, PRESET_HELP.split("\n")[3]!.trim());
    const environmentKind = parsePresetEnvironment(
      option(args, "environment"),
      "project-default",
    );
    const baseBranch = option(args, "base-branch");
    const machine = option(args, "machine");
    validatePresetTargetOptions({ environmentKind, baseBranch, machine });
    const result = tasksRpcContract.createPreset.output.parse(
      await domain.createPreset(
        tasksRpcContract.createPreset.input.parse({
          name: requireOption(args, "name"),
          providerId: requireOption(args, "provider"),
          modelId: requireOption(args, "model"),
          reasoningLevel: requireOption(args, "reasoning"),
          serviceTier:
            parsePresetServiceTier(option(args, "service-tier")) ?? null,
          permissionMode: requireOption(args, "permission"),
          environmentKind,
          baseBranch: baseBranch ?? null,
          machineId:
            machine === undefined
              ? null
              : await resolveMachineId(domain, machine),
          instructions: option(args, "instructions") ?? "",
        }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify(result)
      : `Created preset ${result.preset.name}  ${result.preset.id}`;
  }

  if (action === "update") {
    assertAllowed(args, [
      "name",
      "provider",
      "model",
      "reasoning",
      "service-tier",
      "permission",
      "environment",
      "base-branch",
      "machine",
      "instructions",
    ]);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks preset update <name-or-id> [options] [--json]",
    );
    const preset = resolvePreset(await listPresets(domain), address!);
    const environmentOption = option(args, "environment");
    const environmentKind = parsePresetEnvironment(
      environmentOption,
      preset.environmentKind,
    );
    const baseBranch = option(args, "base-branch");
    const machine = option(args, "machine");
    validatePresetTargetOptions({ environmentKind, baseBranch, machine });
    const result = tasksRpcContract.updatePreset.output.parse(
      await domain.updatePreset(
        tasksRpcContract.updatePreset.input.parse({
          presetId: preset.id,
          name: option(args, "name"),
          providerId: option(args, "provider"),
          modelId: option(args, "model"),
          reasoningLevel: option(args, "reasoning"),
          serviceTier: parsePresetServiceTier(option(args, "service-tier")),
          permissionMode: option(args, "permission"),
          environmentKind:
            environmentOption === undefined ? undefined : environmentKind,
          baseBranch:
            environmentOption !== undefined &&
            environmentKind === "project-default"
              ? null
              : baseBranch,
          machineId:
            environmentOption !== undefined &&
            environmentKind === "project-default"
              ? null
              : machine === undefined
                ? undefined
                : await resolveMachineId(domain, machine),
          instructions: option(args, "instructions"),
        }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify(result)
      : `Updated preset ${result.preset.name}  ${result.preset.id}`;
  }

  if (action === "delete") {
    assertAllowed(args, []);
    const [address] = requirePositionals(
      args,
      1,
      "bb tasks preset delete <name-or-id> [--json]",
    );
    const preset = resolvePreset(await listPresets(domain), address!);
    const result = tasksRpcContract.deletePreset.output.parse(
      await domain.deletePreset(
        tasksRpcContract.deletePreset.input.parse({ presetId: preset.id }),
      ),
    );
    return args.flags.has("json")
      ? JSON.stringify({ ...result, preset })
      : `Deleted preset ${preset.name}`;
  }

  throw new CliError(`unknown preset subcommand: ${action}`);
}

async function runDispatch(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return DISPATCH_HELP;
  assertAllowed(args, ["preset", "instructions"]);
  const [address] = requirePositionals(args, 1, DISPATCH_HELP);
  const task = await resolveTask(domain, address!);
  const preset = resolvePreset(
    await listPresets(domain),
    requireOption(args, "preset"),
  );
  const result = delegationRpcContract.delegate.output.parse(
    await delegationHandlers(bb, store).delegate(
      delegationRpcContract.delegate.input.parse({
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: option(args, "instructions"),
      }),
    ),
  );
  return args.flags.has("json")
    ? JSON.stringify({ task, preset, ...result })
    : result.threadId;
}

function resolveInvokingThreadId(
  args: ParsedArgs,
  ctx: PluginCliContext,
): string {
  const threadId =
    option(args, "thread") ?? process.env.BB_THREAD_ID ?? ctx.threadId;
  if (!threadId) {
    throw new CliError("missing --thread and BB_THREAD_ID is not set");
  }
  return threadId;
}

async function runAttach(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return ATTACH_HELP;
  assertAllowed(args, ["thread"]);
  const [address] = requirePositionals(args, 1, ATTACH_HELP);
  const task = await resolveTask(domain, address!);
  const threadId = resolveInvokingThreadId(args, ctx);
  const result = delegationRpcContract.taskThreadsAttach.output.parse(
    await delegationHandlers(bb, store).taskThreadsAttach(
      delegationRpcContract.taskThreadsAttach.input.parse({
        taskId: task.id,
        threadId,
      }),
    ),
  );
  return args.flags.has("json")
    ? JSON.stringify({ task, ...result })
    : `Attached ${result.threadId} to ${task.key}`;
}

async function runDetach(
  bb: BbPluginApi,
  store: TasksApiStore,
  domain: TasksDomain,
  ctx: PluginCliContext,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return DETACH_HELP;
  assertAllowed(args, ["thread"]);
  const [address] = requirePositionals(args, 1, DETACH_HELP);
  const task = await resolveTask(domain, address!);
  const threadId = resolveInvokingThreadId(args, ctx);
  const result = delegationRpcContract.taskThreadsDetach.output.parse(
    await delegationHandlers(bb, store).taskThreadsDetach(
      delegationRpcContract.taskThreadsDetach.input.parse({
        taskId: task.id,
        threadId,
      }),
    ),
  );
  return args.flags.has("json")
    ? JSON.stringify({ task, ...result })
    : `Detached ${result.threadId} from ${task.key}`;
}

async function runThreads(
  domain: TasksDomain,
  argv: string[],
): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return THREADS_HELP;
  assertAllowed(args, []);
  const [address] = requirePositionals(args, 1, THREADS_HELP);
  const task = await resolveTask(domain, address!);
  const result = tasksRpcContract.listTaskThreads.output.parse(
    await domain.listTaskThreads(
      tasksRpcContract.listTaskThreads.input.parse({ taskId: task.id }),
    ),
  );
  return args.flags.has("json")
    ? JSON.stringify({ task, taskThreads: result.taskThreads })
    : table(
        ["THREAD", "STATUS", "PRESET", "TITLE"],
        result.taskThreads.map((thread) => [
          thread.threadId,
          thread.liveStatus,
          thread.presetName,
          thread.title,
        ]),
        "No attached threads.",
      );
}

function friendlyError(error: unknown): string {
  if (error instanceof CliError) return error.message;
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue?.message ?? "invalid input"}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed: projects.prefix")) {
    return "project prefix is already in use";
  }
  if (
    message.includes("UNIQUE constraint failed: labels.project_id, labels.name")
  ) {
    return "label name is already in use in this project";
  }
  return message;
}

function singleLine(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function registerTasksCli(
  bb: BbPluginApi,
  store: TasksApiStore,
  status: PluginStatus,
): void {
  const domain = registerHandlers(bb, store);
  bb.cli.register({
    name: "tasks",
    summary:
      "Create and manage task-tracker projects, tasks, labels, and comments",
    commands: [
      {
        name: "status",
        summary: "Show the Tasks plugin name and version",
        usage: "bb tasks status [--json]",
      },
      {
        name: "project",
        summary: "Create, list, show, or update tracker projects",
        usage: PROJECT_HELP,
      },
      {
        name: "folder",
        summary: "Create, list, update, or delete project folders",
        usage: FOLDER_HELP,
      },
      {
        name: "create",
        summary: "Create a task",
        usage: CREATE_HELP,
      },
      {
        name: "list",
        summary: "List and filter tasks",
        usage: LIST_HELP,
      },
      {
        name: "show",
        summary: "Show full task details",
        usage: SHOW_HELP,
      },
      {
        name: "update",
        summary: "Update task fields and labels",
        usage: UPDATE_HELP,
      },
      {
        name: "comment",
        summary: "Add a markdown comment to a task",
        usage: COMMENT_HELP,
      },
      {
        name: "label",
        summary: "Create, list, or delete project labels",
        usage: LABEL_HELP,
      },
      {
        name: "attachment",
        summary: "Add, download, list, or remove task attachments",
        usage: ATTACHMENT_HELP,
      },
      {
        name: "preset",
        summary: "List, show, create, update, or delete dispatch presets",
        usage: PRESET_HELP,
      },
      {
        name: "dispatch",
        summary: "Dispatch a task to a new agent thread",
        usage: DISPATCH_HELP,
      },
      {
        name: "attach",
        summary: "Attach an existing agent thread to a task",
        usage: ATTACH_HELP,
      },
      {
        name: "detach",
        summary: "Detach an agent thread from a task",
        usage: DETACH_HELP,
      },
      {
        name: "threads",
        summary: "List agent threads attached to a task",
        usage: THREADS_HELP,
      },
      {
        name: "seed-demo",
        summary: "Create sample folders, projects, labels, tasks, and comments",
        usage: "bb tasks seed-demo --yes [--json]",
      },
    ],
    async run(argv, ctx): Promise<PluginCliResult> {
      try {
        const [command, ...rest] = argv;
        if (!command || command === "--help" || command === "help") {
          return { exitCode: 0, stdout: ROOT_HELP };
        }
        let stdout: string;
        switch (command) {
          case "status": {
            const args = parseArgs(rest);
            assertAllowed(args, []);
            requirePositionals(args, 0, "bb tasks status [--json]");
            stdout = args.flags.has("json")
              ? JSON.stringify(status)
              : `${status.name} ${status.version}`;
            break;
          }
          case "project":
            stdout = await runProject(bb, store, domain, rest);
            break;
          case "folder":
            stdout = await runFolder(bb, store, domain, rest);
            break;
          case "create": {
            const result = await runCreate(bb, store, domain, ctx, rest);
            if (typeof result !== "string") return result;
            stdout = result;
            break;
          }
          case "list":
            stdout = await runList(domain, ctx, rest);
            break;
          case "show":
            stdout = await runShow(domain, rest);
            break;
          case "update":
            stdout = await runUpdate(bb, domain, ctx, rest);
            break;
          case "comment":
            stdout = await runComment(bb, store, domain, ctx, rest);
            break;
          case "label":
            stdout = await runLabel(domain, rest);
            break;
          case "attachment":
            stdout = await runAttachment(bb, store, domain, ctx, rest);
            break;
          case "preset":
            stdout = await runPreset(domain, rest);
            break;
          case "dispatch":
          case "delegate":
            stdout = await runDispatch(bb, store, domain, rest);
            break;
          case "attach":
            stdout = await runAttach(bb, store, domain, ctx, rest);
            break;
          case "detach":
            stdout = await runDetach(bb, store, domain, ctx, rest);
            break;
          case "threads":
            stdout = await runThreads(domain, rest);
            break;
          case "seed-demo": {
            const args = parseArgs(rest);
            assertAllowed(args, [], ["yes"]);
            requirePositionals(args, 0, "bb tasks seed-demo --yes [--json]");
            if (!args.flags.has("yes")) {
              throw new CliError(
                "seed-demo creates sample data; re-run with --yes",
              );
            }
            const result = await seedDemo(domain, ctx.projectId);
            stdout = args.flags.has("json")
              ? JSON.stringify(result)
              : detail([
                  ["Folders", result.foldersCreated],
                  ["Projects", result.projectsCreated],
                  ["Labels", result.labelsCreated],
                  ["Tasks", result.tasksCreated],
                  ["Comments", result.commentsCreated],
                  ["BB project", result.linkedBbProjectId ?? "-"],
                ]);
            break;
          }
          default:
            throw new CliError(
              `unknown command: ${command}; run bb tasks --help`,
            );
        }
        return { exitCode: 0, stdout };
      } catch (error) {
        return { exitCode: 1, stderr: singleLine(friendlyError(error)) };
      }
    },
  });
}
