import { Buffer } from "node:buffer";
import path from "node:path";
import { listQueuedThreadMessages } from "@bb/db";
import {
  FILE_LIST_LIMIT_MAX,
  type HostDaemonCommand,
  type HostReadFileRelativeDotfilePolicy,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { marked } from "marked";
import { PROMPT_HISTORY_ENTRY_LIMIT, threadEventTypeSchema } from "@bb/domain";
import {
  promptHistoryQuerySchema,
  threadHostFileContentQuerySchema,
  threadStorageContentQuerySchema,
  threadStorageFilesQuerySchema,
  threadStoragePathsQuerySchema,
  threadEventWaitQuerySchema,
  threadEventsQuerySchema,
  threadTimelineQuerySchema,
  timelineTurnSummaryDetailsQuerySchema,
  typedRoutes,
  type PublicApiSchema,
  type ThreadComposerBootstrapResponse,
  type ThreadStatusVersionResponse,
  type ThreadTimelineQuery,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedWorkSessionDeps,
  WorkSessionDeps,
} from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  requireEnvironment,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { queueCommandAndWait } from "../../services/hosts/command-wait.js";
import {
  createDaemonFileContentResponse,
  decodeDaemonFileContent,
  type DaemonFileReadResult,
  remapDaemonFileRouteError,
} from "../../services/hosts/daemon-file-response.js";
import { requireThreadStoragePath } from "../../services/threads/thread-storage.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import {
  buildThreadTimeline,
  buildTimelineTurnSummaryDetails,
  resolveThreadTimelineServiceViewMode,
  THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  THREAD_TIMELINE_SEGMENT_LIMIT_MAX,
  type ThreadTimelinePageKind,
  type ThreadTimelinePageRequest,
} from "../../services/threads/timeline.js";
import {
  findThreadEvent,
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/threads/thread-data.js";
import { getLastExecutionOptions } from "../../services/threads/thread-events.js";
import { resolveSystemExecutionOptions } from "../../services/system/execution-options.js";
import { listThreadPromptHistory } from "../../services/prompt-history.js";
import {
  parseInteger,
  parseOptionalInteger,
} from "../../services/lib/validation.js";
import { parsePathKindInclusion } from "../path-list-inclusion.js";

interface ThreadComposerExecutionOptionsSource {
  archivedAt: number | null;
  environmentId: string | null;
}

interface ShouldResolveThreadComposerExecutionOptionsArgs {
  thread: ThreadComposerExecutionOptionsSource;
}

function shouldResolveThreadComposerExecutionOptions({
  thread,
}: ShouldResolveThreadComposerExecutionOptionsArgs): boolean {
  return thread.archivedAt === null && thread.environmentId !== null;
}

async function buildThreadComposerBootstrapResponse(
  deps: AppDeps,
  threadId: string,
): Promise<ThreadComposerBootstrapResponse> {
  const thread = requirePublicThread(deps.db, threadId);
  const defaultExecutionOptions = getLastExecutionOptions(deps, threadId);
  const composerEnvironmentId = shouldResolveThreadComposerExecutionOptions({
    thread,
  })
    ? thread.environmentId
    : null;
  const executionOptions = composerEnvironmentId
    ? await resolveSystemExecutionOptions(deps, {
        environmentId: composerEnvironmentId,
        providerId: thread.providerId,
      })
    : {
        providers: [],
        models: [],
        selectedOnlyModels: [],
      };
  return {
    defaultExecutionOptions,
    queuedMessages: listQueuedThreadMessages(deps.db, threadId).map(
      toThreadQueuedMessage,
    ),
    executionOptions,
    pendingInteractions:
      deps.pendingInteractions.listPendingThreadInteractions(threadId),
    promptHistory: listThreadPromptHistory(deps, {
      threadId,
      limit: PROMPT_HISTORY_ENTRY_LIMIT,
    }),
  };
}

function validateFilePath(filePath: string): void {
  if (
    filePath.startsWith("/") ||
    filePath.split("/").includes("..") ||
    filePath.split("\\").includes("..")
  ) {
    throw new ApiError(400, "invalid_request", "Invalid file path");
  }
}

interface ThreadStorageTarget {
  hostId: string;
  storagePath: string;
}

interface RequireThreadStorageTargetArgs {
  threadId: string;
}

interface ReadThreadStorageStatusFileArgs {
  target: ThreadStorageTarget;
  rootPath: string;
  relativePath: string;
  dotfiles: HostReadFileRelativeDotfilePolicy;
}

type HostStatusVersionCommand = Extract<
  HostDaemonCommand,
  { type: "host.status_version" }
>;

interface StatusAssetPath {
  relativePath: string;
}

const STATUS_DIRECTORY_NAME = "STATUS";
const STATUS_INDEX_FILE_PATH = "index.html";
const STATUS_HTML_FILE_PATH = "STATUS.html";
const STATUS_MARKDOWN_FILE_PATH = "STATUS.md";
const STATUS_ROUTE_SEGMENT = "/status/";
const STATUS_NO_STORE_CACHE_CONTROL = "no-store";
const STATUS_HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const STATUS_CONTENT_TYPE_OPTIONS = "nosniff";
const UNUSABLE_STATUS_SOURCE_ERROR_CODES = new Set([
  "EACCES",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "invalid_path",
]);

function parseThreadStorageFileListLimit(rawLimit: string | undefined): number {
  const limit = Math.min(
    parseOptionalInteger(rawLimit, "limit") ?? 1000,
    FILE_LIST_LIMIT_MAX,
  );
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "limit must be a positive integer",
    );
  }
  return limit;
}

function parseThreadTimelineSegmentLimit(
  defaultLimit: number,
  rawLimit: string | undefined,
): number {
  const limit = parseOptionalInteger(rawLimit, "segmentLimit") ?? defaultLimit;
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "segmentLimit must be a positive integer",
    );
  }
  if (limit > THREAD_TIMELINE_SEGMENT_LIMIT_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `segmentLimit must be less than or equal to ${THREAD_TIMELINE_SEGMENT_LIMIT_MAX}`,
    );
  }
  return limit;
}

function parseThreadTimelinePage(
  query: ThreadTimelineQuery,
): ThreadTimelinePageRequest {
  const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
  const kind: ThreadTimelinePageKind = hasBeforeAnchorSeq ? "older" : "latest";
  const segmentLimit = parseThreadTimelineSegmentLimit(
    THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
    query.segmentLimit,
  );

  if (kind === "latest") {
    return {
      kind,
      segmentLimit,
    };
  }

  if (
    query.beforeAnchorSeq === undefined ||
    query.beforeAnchorId === undefined
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "beforeAnchorSeq and beforeAnchorId must be provided together",
    );
  }

  return {
    beforeCursor: {
      anchorSeq: parseInteger(query.beforeAnchorSeq, "beforeAnchorSeq"),
      anchorId: query.beforeAnchorId,
    },
    kind,
    segmentLimit,
  };
}

async function requireThreadStorageTarget(
  deps: WorkSessionDeps,
  args: RequireThreadStorageTargetArgs,
): Promise<ThreadStorageTarget> {
  const thread = requirePublicThread(deps.db, args.threadId);
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  const environment = requireEnvironment(deps.db, thread.environmentId);
  return {
    hostId: environment.hostId,
    storagePath: await requireThreadStoragePath(deps, {
      hostId: environment.hostId,
      threadId: thread.id,
    }),
  };
}

function createStatusNotFoundError(relativePath: string): ApiError {
  return new ApiError(404, "ENOENT", `Path does not exist: ${relativePath}`);
}

function createStatusInvalidPathError(): ApiError {
  return new ApiError(400, "invalid_path", "Invalid status asset path");
}

function decodeStatusRoutePath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    throw createStatusInvalidPathError();
  }
}

function parseStatusAssetPath(rawPath: string): StatusAssetPath {
  const decodedPath = decodeStatusRoutePath(rawPath);
  const requestedDirectoryIndex = decodedPath.endsWith("/");
  const relativePath = requestedDirectoryIndex
    ? `${decodedPath}${STATUS_INDEX_FILE_PATH}`
    : decodedPath;

  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw createStatusInvalidPathError();
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw createStatusInvalidPathError();
  }

  if (segments.some((segment) => segment.startsWith("."))) {
    throw createStatusNotFoundError(relativePath);
  }

  return {
    relativePath: segments.join("/"),
  };
}

function extractThreadStatusPath(requestUrl: string): string {
  const requestPath = new URL(requestUrl).pathname;
  const statusSegmentIndex = requestPath.indexOf(STATUS_ROUTE_SEGMENT);
  if (statusSegmentIndex === -1) {
    return "";
  }
  return requestPath.slice(statusSegmentIndex + STATUS_ROUTE_SEGMENT.length);
}

function shouldFallbackStatusRead(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    UNUSABLE_STATUS_SOURCE_ERROR_CODES.has(error.body.code)
  );
}

function remapStatusAssetReadError(error: unknown): never {
  if (!(error instanceof ApiError)) {
    throw error;
  }

  if (error.body.code === "ENOENT") {
    throw new ApiError(
      404,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }
  if (error.body.code === "invalid_path") {
    throw new ApiError(
      400,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }
  throw error;
}

async function readThreadStorageStatusFile(
  deps: LoggedWorkSessionDeps,
  args: ReadThreadStorageStatusFileArgs,
): Promise<DaemonFileReadResult> {
  return queueCommandAndWait(deps, {
    hostId: args.target.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.read_file_relative",
      rootPath: args.rootPath,
      path: args.relativePath,
      dotfiles: args.dotfiles,
    },
  });
}

async function tryReadThreadStorageStatusFile(
  deps: LoggedWorkSessionDeps,
  args: ReadThreadStorageStatusFileArgs,
): Promise<DaemonFileReadResult | null> {
  try {
    return await readThreadStorageStatusFile(deps, args);
  } catch (error) {
    if (shouldFallbackStatusRead(error)) {
      return null;
    }
    throw error;
  }
}

function buildStatusVersionCommand(
  target: ThreadStorageTarget,
): HostStatusVersionCommand {
  return {
    type: "host.status_version",
    sources: [
      {
        source: "folder",
        rootPath: path.join(target.storagePath, STATUS_DIRECTORY_NAME),
        indexPath: STATUS_INDEX_FILE_PATH,
        dotfiles: "deny",
      },
      {
        source: "html",
        rootPath: target.storagePath,
        path: STATUS_HTML_FILE_PATH,
        dotfiles: "allow",
      },
      {
        source: "md",
        rootPath: target.storagePath,
        path: STATUS_MARKDOWN_FILE_PATH,
        dotfiles: "allow",
      },
    ],
  };
}

async function readThreadStatusVersion(
  deps: LoggedWorkSessionDeps,
  threadId: string,
): Promise<ThreadStatusVersionResponse> {
  const target = await requireThreadStorageTarget(deps, { threadId });
  return queueCommandAndWait(deps, {
    hostId: target.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: buildStatusVersionCommand(target),
  });
}

function createStatusHtmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": STATUS_NO_STORE_CACHE_CONTROL,
      "content-type": STATUS_HTML_CONTENT_TYPE,
      "x-content-type-options": STATUS_CONTENT_TYPE_OPTIONS,
    },
  });
}

function createStatusFileResponse(
  result: DaemonFileReadResult,
  cacheControl: string,
): Response {
  return createDaemonFileContentResponse(result, {
    headers: {
      "cache-control": cacheControl,
      "x-content-type-options": STATUS_CONTENT_TYPE_OPTIONS,
    },
  });
}

function decodeDaemonTextFile(result: DaemonFileReadResult): string {
  return Buffer.from(decodeDaemonFileContent(result)).toString("utf8");
}

function createStatusDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  color-scheme: light;
  --background: oklch(0.9551 0 0);
  --foreground: oklch(0.3211 0 0);
  --card: oklch(0.9702 0 0);
  --muted-foreground: oklch(0.5103 0 0);
  --border: oklch(0.8576 0 0);
  --font-sans: "Inter Variable", Inter, sans-serif;
  --font-mono: "Fira Code", monospace;
  --radius: 0.35rem;
  --shadow-sm: 0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 1px 2px -1px hsl(0 0% 20% / 0.15);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --background: oklch(0.195 0 0);
    --foreground: oklch(0.8853 0 0);
    --card: oklch(0.2435 0 0);
    --muted-foreground: oklch(0.66 0 0);
    --border: oklch(0.329 0 0);
  }
}
html, body {
  margin: 0;
  min-height: 100%;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 0.9375rem;
  line-height: 1.375rem;
}
body {
  padding: 1rem;
}
.status-markdown {
  max-width: 56rem;
}
.status-markdown > :first-child {
  margin-top: 0;
}
.status-markdown h1,
.status-markdown h2,
.status-markdown h3 {
  line-height: 1.2;
}
.status-markdown code {
  font-family: var(--font-mono);
  font-size: 0.875em;
}
.status-markdown pre {
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  padding: 0.75rem;
}
.status-empty {
  max-width: 28rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-sm);
  padding: 1rem;
}
.status-empty h1 {
  margin: 0 0 0.25rem;
  font-size: 0.9375rem;
  line-height: 1.375rem;
}
.status-empty p {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

async function createMarkdownStatusResponse(
  result: DaemonFileReadResult,
): Promise<Response> {
  const renderedMarkdown = await marked.parse(decodeDaemonTextFile(result), {
    gfm: true,
  });
  return createStatusHtmlResponse(
    createStatusDocument(
      STATUS_MARKDOWN_FILE_PATH,
      `<main class="status-markdown">${renderedMarkdown}</main>`,
    ),
  );
}

function createEmptyStatusResponse(): Response {
  return createStatusHtmlResponse(
    createStatusDocument(
      "Manager status",
      `<main class="status-empty" role="status">
  <h1>No manager status yet</h1>
  <p>Create STATUS/index.html, STATUS.html, or STATUS.md in this manager thread's storage.</p>
</main>`,
    ),
  );
}

async function serveThreadStatusRoot(
  deps: LoggedWorkSessionDeps,
  threadId: string,
): Promise<Response> {
  const target = await requireThreadStorageTarget(deps, { threadId });
  const statusRootPath = path.join(target.storagePath, STATUS_DIRECTORY_NAME);
  const statusIndex = await tryReadThreadStorageStatusFile(deps, {
    target,
    rootPath: statusRootPath,
    relativePath: STATUS_INDEX_FILE_PATH,
    dotfiles: "deny",
  });
  if (statusIndex) {
    return createStatusFileResponse(statusIndex, STATUS_NO_STORE_CACHE_CONTROL);
  }

  const statusHtml = await tryReadThreadStorageStatusFile(deps, {
    target,
    rootPath: target.storagePath,
    relativePath: STATUS_HTML_FILE_PATH,
    dotfiles: "allow",
  });
  if (statusHtml) {
    return createStatusFileResponse(statusHtml, STATUS_NO_STORE_CACHE_CONTROL);
  }

  const statusMarkdown = await tryReadThreadStorageStatusFile(deps, {
    target,
    rootPath: target.storagePath,
    relativePath: STATUS_MARKDOWN_FILE_PATH,
    dotfiles: "allow",
  });
  if (statusMarkdown) {
    return createMarkdownStatusResponse(statusMarkdown);
  }

  return createEmptyStatusResponse();
}

async function serveThreadStatusAsset(
  deps: LoggedWorkSessionDeps,
  threadId: string,
  rawPath: string,
): Promise<Response> {
  const assetPath = parseStatusAssetPath(rawPath);
  const target = await requireThreadStorageTarget(deps, { threadId });

  try {
    const result = await readThreadStorageStatusFile(deps, {
      target,
      rootPath: path.join(target.storagePath, STATUS_DIRECTORY_NAME),
      relativePath: assetPath.relativePath,
      dotfiles: "deny",
    });
    return createStatusFileResponse(result, STATUS_NO_STORE_CACHE_CONTROL);
  } catch (error) {
    return remapStatusAssetReadError(error);
  }
}

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/threads/:id/timeline", threadTimelineQuerySchema, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      buildThreadTimeline(deps.db, thread, {
        isDevelopment: deps.config.isDevelopment,
        timelineViewMode: resolveThreadTimelineServiceViewMode({
          managerTimelineView: query.managerTimelineView,
          thread,
        }),
        includeNestedRows: query.includeNestedRows === "true",
        page: parseThreadTimelinePage(query),
        summaryOnly: query.summaryOnly === "true",
      }),
    );
  });

  get(
    "/threads/:id/timeline/turn-summary-details",
    timelineTurnSummaryDetailsQuerySchema,
    (context, query) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));
      return context.json(
        buildTimelineTurnSummaryDetails(deps.db, thread, {
          isDevelopment: deps.config.isDevelopment,
          turnId: query.turnId,
          sourceSeqStart: parseInteger(query.sourceSeqStart, "sourceSeqStart"),
          sourceSeqEnd: parseInteger(query.sourceSeqEnd, "sourceSeqEnd"),
          timelineViewMode: resolveThreadTimelineServiceViewMode({
            managerTimelineView: query.managerTimelineView,
            thread,
          }),
        }),
      );
    },
  );

  get("/threads/:id/output", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json({
      output: getLastThreadOutput(deps.db, context.req.param("id")),
    });
  });

  get("/threads/:id/composer-bootstrap", async (context) =>
    context.json(
      await buildThreadComposerBootstrapResponse(deps, context.req.param("id")),
    ),
  );

  get("/threads/:id/queued-messages", (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(
      listQueuedThreadMessages(deps.db, threadId).map(toThreadQueuedMessage),
    );
  });

  get(
    "/threads/:id/prompt-history",
    promptHistoryQuerySchema,
    (context, query) => {
      const threadId = context.req.param("id");
      requirePublicThread(deps.db, threadId);
      const limit = Math.min(
        parseOptionalInteger(query.limit, "limit") ??
          PROMPT_HISTORY_ENTRY_LIMIT,
        PROMPT_HISTORY_ENTRY_LIMIT,
      );
      if (limit <= 0) {
        throw new ApiError(
          400,
          "invalid_request",
          "limit must be a positive integer",
        );
      }

      return context.json(
        listThreadPromptHistory(deps, {
          threadId,
          limit,
        }),
      );
    },
  );

  get("/threads/:id/events", threadEventsQuerySchema, (context, query) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      listThreadEventRows(deps.db, {
        threadId: context.req.param("id"),
        afterSeq: parseOptionalInteger(query.afterSeq, "afterSeq"),
        limit: parseOptionalInteger(query.limit, "limit") ?? 100,
      }),
    );
  });

  get(
    "/threads/:id/events/wait",
    threadEventWaitQuerySchema,
    async (context, query) => {
      const threadId = context.req.param("id");
      requirePublicThread(deps.db, threadId);

      const afterSeq = parseOptionalInteger(query.afterSeq, "afterSeq");
      const waitMs = Math.min(
        parseOptionalInteger(query.waitMs, "waitMs") ?? 30_000,
        60_000,
      );
      const parsedEventType = threadEventTypeSchema.safeParse(query.type);
      if (!parsedEventType.success) {
        throw new ApiError(400, "invalid_request", "Invalid event type");
      }
      const eventType = parsedEventType.data;

      const findMatch = () =>
        findThreadEvent(deps.db, { threadId, type: eventType, afterSeq });

      const deadline = Date.now() + waitMs;
      let match = findMatch();
      while (!match) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const waiter = deps.hub.registerThreadEventWaiter(threadId, remaining);
        match = findMatch();
        if (match) {
          waiter.cancel();
          break;
        }
        await waiter.promise;
        match = findMatch();
      }

      if (!match) {
        return new Response(null, { status: 204 });
      }

      return context.json(match);
    },
  );

  get("/threads/:id/default-execution-options", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(getLastExecutionOptions(deps, context.req.param("id")));
  });

  get("/threads/:id/status-version", async (context) => {
    context.header("cache-control", STATUS_NO_STORE_CACHE_CONTROL);
    return context.json(
      await readThreadStatusVersion(deps, context.req.param("id")),
    );
  });

  app.get("/threads/:id/status", (context) => {
    const requestPath = new URL(context.req.url).pathname;
    return context.redirect(`${requestPath}/`, 308);
  });

  // This route intentionally sits outside @bb/server-contract: it returns
  // arbitrary manager-authored HTML/static bytes, including wildcard asset
  // paths, rather than a typed JSON API response.
  app.get("/threads/:id/status/", async (context) =>
    serveThreadStatusRoot(deps, context.req.param("id")),
  );

  app.get("/threads/:id/status/*", async (context) => {
    const rawStatusPath = extractThreadStatusPath(context.req.url);
    if (rawStatusPath.length === 0) {
      return serveThreadStatusRoot(deps, context.req.param("id"));
    }
    return serveThreadStatusAsset(deps, context.req.param("id"), rawStatusPath);
  });

  get(
    "/threads/:id/thread-storage/files",
    threadStorageFilesQuerySchema,
    async (context, query) => {
      const target = await requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });
      const limit = parseThreadStorageFileListLimit(query.limit);

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.list_files",
            path: target.storagePath,
            ...(query.query ? { query: query.query } : {}),
            limit,
          },
        });
        return context.json({
          files: result.files,
          truncated: result.truncated,
          storageRootPath: target.storagePath,
        });
      } catch (error) {
        if (error instanceof ApiError && error.body.code === "ENOENT") {
          return context.json({
            files: [],
            truncated: false,
            storageRootPath: target.storagePath,
          });
        }
        throw error;
      }
    },
  );

  get(
    "/threads/:id/thread-storage/paths",
    threadStoragePathsQuerySchema,
    async (context, query) => {
      const target = await requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });
      const limit = parseThreadStorageFileListLimit(query.limit);
      const inclusion = parsePathKindInclusion({
        includeFiles: query.includeFiles,
        includeDirectories: query.includeDirectories,
      });

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.list_paths",
            path: target.storagePath,
            ...(query.query ? { query: query.query } : {}),
            limit,
            includeFiles: inclusion.includeFiles,
            includeDirectories: inclusion.includeDirectories,
          },
        });
        return context.json({
          paths: result.paths,
          truncated: result.truncated,
          storageRootPath: target.storagePath,
        });
      } catch (error) {
        if (error instanceof ApiError && error.body.code === "ENOENT") {
          return context.json({
            paths: [],
            truncated: false,
            storageRootPath: target.storagePath,
          });
        }
        throw error;
      }
    },
  );

  get(
    "/threads/:id/thread-storage/content",
    threadStorageContentQuerySchema,
    async (context, query) => {
      validateFilePath(query.path);
      const target = await requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.read_file",
            path: path.join(target.storagePath, query.path),
            rootPath: target.storagePath,
          },
        });
        return createDaemonFileContentResponse(result);
      } catch (error) {
        return remapDaemonFileRouteError(error);
      }
    },
  );

  get(
    "/threads/:id/host-files/content",
    threadHostFileContentQuerySchema,
    async (context, query) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));
      if (!thread.environmentId) {
        throw new ApiError(409, "invalid_request", "Thread has no environment");
      }
      const environment = requireEnvironment(deps.db, thread.environmentId);

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.read_file",
            path: query.path,
          },
        });
        return createDaemonFileContentResponse(result);
      } catch (error) {
        return remapDaemonFileRouteError(error);
      }
    },
  );
}
