import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineApprovalWorkRow,
  TimelineCommandWorkRow,
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineConversationUserRequest,
  TimelineDelegationWorkRow,
  TimelineDiffStats,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineToolWorkRow,
  TimelineTurnRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";

export interface BaseRowArgs {
  id: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  turnId?: string | null;
}

export interface ConversationRowArgs {
  attachments?: TimelineConversationAttachments | null;
  id?: string;
  role?: TimelineConversationRow["role"];
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  text: string;
  turnId?: string | null;
  userRequest?: TimelineConversationUserRequest;
}

export interface CommandRowArgs {
  activityIntents?: TimelineActivityIntent[];
  approvalStatus?: TimelineApprovalStatus;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  exitCode?: number | null;
  id?: string;
  output?: string;
  seq?: number;
  source?: string | null;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  turnId?: string | null;
}

export interface ToolRowArgs {
  activityIntents?: TimelineActivityIntent[];
  approvalStatus?: TimelineApprovalStatus;
  durationMs?: number | null;
  id?: string;
  label?: string;
  output?: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  toolArgs?: TimelineToolWorkRow["toolArgs"];
  toolName?: string;
  turnId?: string | null;
}

export interface FileChangeRowArgs {
  approvalStatus?: TimelineApprovalStatus;
  change?: TimelineFileChange;
  diff?: string | null;
  diffStats?: TimelineDiffStats;
  id?: string;
  kind?: string | null;
  movePath?: string | null;
  path?: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  stderr?: string | null;
  stdout?: string | null;
  turnId?: string | null;
}

export interface WebSearchRowArgs {
  callId?: string;
  durationMs?: number | null;
  id?: string;
  queries?: string[];
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  turnId?: string | null;
}

export interface WebFetchRowArgs {
  callId?: string;
  durationMs?: number | null;
  id?: string;
  pattern?: string | null;
  prompt?: string | null;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  turnId?: string | null;
  url?: string;
}

export interface ApprovalRowArgs {
  id?: string;
  interactionId?: string;
  itemId?: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  title: string;
  toolName?: string | null;
  turnId?: string | null;
}

export interface SystemRowArgs {
  detail?: string | null;
  id?: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineSystemRow["status"];
  systemKind?: TimelineSystemRow["systemKind"];
  title?: string;
  turnId?: string | null;
}

export interface DelegationRowArgs {
  childRows?: TimelineRow[];
  description?: string | null;
  durationMs?: number | null;
  id?: string;
  output?: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  subagentType?: string | null;
  toolName?: string;
  turnId?: string | null;
}

export interface TurnRowArgs {
  children?: TimelineRow[] | null;
  durationMs?: number | null;
  id?: string;
  seq?: number;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
  summaryCount?: number;
  turnId?: string;
}

export interface ReadIntentArgs {
  path: string;
}

export interface ListFilesIntentArgs {
  path: string | null;
}

export interface SearchIntentArgs {
  path: string | null;
  query: string;
}

export interface UnknownIntentArgs {
  command: string;
}

interface RowSequenceArgs {
  seq: number | undefined;
  sourceSeqStart: number | undefined;
}

interface CommandExitCodeArgs {
  exitCode: number | null | undefined;
  status: TimelineRowStatus;
}

const DEFAULT_THREAD_ID = "thread-1";
const DEFAULT_TURN_ID = "turn-1";
const DEFAULT_COMMAND_ID = "command-1";
const DEFAULT_CONVERSATION_ID = "conversation-1";
const DEFAULT_DELEGATION_ID = "delegation-1";
const DEFAULT_FILE_CHANGE_ID = "file-change-1";
const DEFAULT_SYSTEM_ID = "system-1";
const DEFAULT_TOOL_ID = "tool-1";
const DEFAULT_TURN_ROW_ID = "turn-summary-1";
const DEFAULT_WEB_FETCH_ID = "web-fetch-1";
const DEFAULT_WEB_SEARCH_ID = "web-search-1";

function rowSequence({ seq, sourceSeqStart }: RowSequenceArgs): number {
  return seq ?? sourceSeqStart ?? 1;
}

/**
 * Fixture inputs are written in terms of `durationMs` (intuitive when
 * authoring "this run took 2 seconds"). Production rows store
 * `completedAt = startedAt + durationMs`; this helper does the conversion
 * so tests stay readable while the row shape remains canonical.
 */
function completedAtFromDuration(
  startedAt: number,
  durationMs: number | null | undefined,
): number | null {
  if (durationMs === null || durationMs === undefined) return null;
  return startedAt + durationMs;
}

function commandExitCode({
  exitCode,
  status,
}: CommandExitCodeArgs): number | null {
  if (exitCode !== undefined) {
    return exitCode;
  }
  // Story and test fixtures default only the common successful command case.
  // Failure and interruption examples should opt into a concrete exit code
  // when the rendered state depends on it.
  return status === "completed" ? 0 : null;
}

export function baseRow({
  id,
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  turnId = DEFAULT_TURN_ID,
}: BaseRowArgs): TimelineRowBase {
  const rowSeq = rowSequence({ seq, sourceSeqStart });
  return {
    id,
    threadId: DEFAULT_THREAD_ID,
    turnId,
    sourceSeqStart: rowSeq,
    sourceSeqEnd: sourceSeqEnd ?? rowSeq,
    startedAt: rowSeq,
    createdAt: rowSeq,
  };
}

export function conversationRow({
  attachments = null,
  id = DEFAULT_CONVERSATION_ID,
  role = "assistant",
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  text,
  turnId,
  userRequest,
}: ConversationRowArgs): TimelineConversationRow {
  const rowBase = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return role === "user"
    ? {
        ...rowBase,
        kind: "conversation",
        role,
        text,
        attachments,
        userRequest: userRequest ?? { kind: "message", status: "accepted" },
      }
    : {
        ...rowBase,
        kind: "conversation",
        role,
        text,
        attachments,
        userRequest: null,
      };
}

export function readIntent({ path }: ReadIntentArgs): TimelineActivityIntent {
  return {
    type: "read",
    command: `cat ${path}`,
    name: path.split("/").pop() ?? path,
    path,
  };
}

export function listFilesIntent({
  path,
}: ListFilesIntentArgs): TimelineActivityIntent {
  return {
    type: "list_files",
    command: path ? `ls ${path}` : "ls",
    path,
  };
}

export function searchIntent({
  query,
  path,
}: SearchIntentArgs): TimelineActivityIntent {
  return {
    type: "search",
    command: path ? `rg ${query} ${path}` : `rg ${query}`,
    query,
    path,
  };
}

export function unknownIntent({
  command,
}: UnknownIntentArgs): TimelineActivityIntent {
  return {
    type: "unknown",
    command,
  };
}

export function commandRow({
  activityIntents = [],
  approvalStatus = null,
  command,
  cwd = "/workspace/bb",
  durationMs = 2_300,
  exitCode,
  id = DEFAULT_COMMAND_ID,
  output = "",
  seq,
  source = "exec_command",
  sourceSeqEnd,
  sourceSeqStart,
  status = "completed",
  turnId,
}: CommandRowArgs): TimelineCommandWorkRow {
  const base = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return {
    ...base,
    kind: "work",
    workKind: "command",
    status,
    callId: id,
    command,
    cwd,
    source,
    output,
    exitCode: commandExitCode({ exitCode, status }),
    completedAt: completedAtFromDuration(base.startedAt, durationMs),
    approvalStatus,
    activityIntents,
  };
}

export function toolRow({
  activityIntents = [],
  approvalStatus = null,
  durationMs = 2_300,
  id = DEFAULT_TOOL_ID,
  label = "Read /workspace/bb/src/app.ts",
  output = "",
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  status = "completed",
  toolArgs = null,
  toolName = "Read",
  turnId,
}: ToolRowArgs = {}): TimelineToolWorkRow {
  const base = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return {
    ...base,
    kind: "work",
    workKind: "tool",
    status,
    callId: id,
    toolName,
    toolArgs,
    label,
    output,
    completedAt: completedAtFromDuration(base.startedAt, durationMs),
    approvalStatus,
    activityIntents,
  };
}

function fileChangeFromArgs({
  change,
  diff = "@@ -1 +1 @@\n-before\n+after",
  diffStats = {
    added: 1,
    removed: 1,
  },
  kind = "update",
  movePath = null,
  path = "src/app.ts",
}: FileChangeRowArgs): TimelineFileChange {
  return (
    change ?? {
      path,
      kind,
      movePath,
      diff,
      diffStats,
    }
  );
}

export function fileChangeRow(
  args: FileChangeRowArgs = {},
): TimelineFileChangeWorkRow {
  const {
    approvalStatus = null,
    id = DEFAULT_FILE_CHANGE_ID,
    seq,
    sourceSeqEnd,
    sourceSeqStart,
    status = "completed",
    stderr = null,
    stdout = "applied",
    turnId,
  } = args;
  return {
    ...baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId }),
    kind: "work",
    workKind: "file-change",
    status,
    callId: id,
    change: fileChangeFromArgs(args),
    stdout,
    stderr,
    approvalStatus,
  };
}

export function webSearchRow({
  callId,
  durationMs = null,
  id = DEFAULT_WEB_SEARCH_ID,
  queries = ["timeline renderer"],
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  status = "completed",
  turnId,
}: WebSearchRowArgs = {}): TimelineWebSearchWorkRow {
  const base = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return {
    ...base,
    kind: "work",
    workKind: "web-search",
    status,
    callId: callId ?? id,
    queries,
    completedAt: completedAtFromDuration(base.startedAt, durationMs),
  };
}

export function webFetchRow({
  callId,
  durationMs = null,
  id = DEFAULT_WEB_FETCH_ID,
  pattern = null,
  prompt = null,
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  status = "completed",
  turnId,
  url = "https://example.com/docs",
}: WebFetchRowArgs = {}): TimelineWebFetchWorkRow {
  const base = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return {
    ...base,
    kind: "work",
    workKind: "web-fetch",
    status,
    callId: callId ?? id,
    url,
    prompt,
    pattern,
    completedAt: completedAtFromDuration(base.startedAt, durationMs),
  };
}

export function approvalRow({
  id = "approval-1",
  interactionId = "approval-interaction-1",
  itemId = "approval-item-1",
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  status = "pending",
  title,
  toolName = null,
  turnId,
}: ApprovalRowArgs): TimelineApprovalWorkRow {
  return {
    ...baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId }),
    kind: "work",
    workKind: "approval",
    status,
    interactionId,
    title,
    target: {
      itemId,
      toolName,
    },
  };
}

export function systemRow({
  detail = "Running setup\nProvisioned thread (2s)",
  id = DEFAULT_SYSTEM_ID,
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  status = "completed",
  systemKind = "operation",
  title = "Provisioned thread",
  turnId = null,
}: SystemRowArgs = {}): TimelineSystemRow {
  return {
    ...baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId }),
    kind: "system",
    systemKind,
    title,
    detail,
    status,
  };
}

export function delegationRow({
  childRows = [
    commandRow({
      id: "delegation-child-command-1",
      command: "rg timeline apps/app",
      seq: 2,
    }),
  ],
  description = "Review renderer",
  durationMs = 2_000,
  id = DEFAULT_DELEGATION_ID,
  output = "Final subagent answer.",
  seq,
  sourceSeqEnd,
  sourceSeqStart,
  status = "completed",
  subagentType = "general-purpose",
  toolName = "spawnAgent",
  turnId,
}: DelegationRowArgs = {}): TimelineDelegationWorkRow {
  const base = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return {
    ...base,
    kind: "work",
    workKind: "delegation",
    status,
    callId: id,
    toolName,
    subagentType,
    description,
    output,
    completedAt: completedAtFromDuration(base.startedAt, durationMs),
    childRows,
  };
}

export function turnRow({
  children = null,
  durationMs = 4_000,
  id = DEFAULT_TURN_ROW_ID,
  seq,
  sourceSeqEnd,
  sourceSeqStart = 10,
  status = "completed",
  summaryCount = 1,
  turnId = DEFAULT_TURN_ID,
}: TurnRowArgs = {}): TimelineTurnRow {
  const base = baseRow({ id, seq, sourceSeqEnd, sourceSeqStart, turnId });
  return {
    ...base,
    kind: "turn",
    turnId,
    status,
    summaryCount,
    completedAt: completedAtFromDuration(base.startedAt, durationMs),
    children,
  };
}
