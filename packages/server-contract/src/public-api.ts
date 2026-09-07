import {
  desktopBrowserHostRequestSchema,
  desktopBrowserScopeSchema,
  desktopBrowserCreateRequestSchema,
  desktopBrowserAcquireRequestSchema,
  desktopBrowserLeaseRequestSchema,
  desktopBrowserTabRequestSchema,
  type ExperimentalDesktopBrowserHostRequest,
  type ExperimentalDesktopBrowserScope,
  type ExperimentalDesktopBrowserCreateInput,
  type ExperimentalDesktopBrowserAcquireInput,
  type ExperimentalDesktopBrowserLeaseRequest,
  type ExperimentalDesktopBrowserTabRequest,
  type ExperimentalDesktopBrowserInstances,
  type ExperimentalDesktopBrowserTabs,
  type ExperimentalDesktopBrowserCreated,
  type ExperimentalDesktopBrowserLease,
  type ExperimentalDesktopBrowserConnection,
  type ExperimentalDesktopBrowserCapture,
} from "./api/desktop-browsers.js";
import type { Hono } from "hono";
import type {
  AppTheme,
  AppThemeSelection,
  AppSettings,
  AppKeybindingOverrides,
  Environment,
  Experiments,
  Host,
  PendingInteraction,
  ProjectExecutionDefaults,
  ProjectSource,
  ResolvedThreadExecutionOptions,
  ThreadEventRow,
  ThreadQueuedMessage,
} from "@bb/domain";
import {
  appSettingsSchema,
  appKeybindingOverridesSchema,
  appThemeSelectionSchema,
  experimentsSchema,
} from "@bb/domain";
import type { ProviderUsageResponse } from "@bb/host-daemon-contract";
import {
  binaryResponse,
  defineRoute,
  formRequest,
  jsonRequest,
  jsonResponse,
  noRequest,
  optionalQueryRequest,
  queryRequest,
  textResponse,
  type ApiSchemaFromRouteDescriptors,
} from "@bb/hono-typed-routes";
import type {
  EmptyInput,
  PathId,
  PathProjectId,
  PathPreviewAndFilePath,
  PathThreadAndFilePath,
  PathThreadAndQueuedMessage,
  PathTerminal,
} from "./common.js";
import type {
  CloseTerminalRequest,
  CommandListResponse,
  CopyProjectAttachmentsRequest,
  CreateHostJoinCodeRequest,
  CreateHostJoinCodeResponse,
  CreateTerminalRequest,
  CreateProjectRequest,
  CreateProjectSourceRequest,
  CreateQueuedMessageRequest,
  CreateThreadSectionRequest,
  CreateThreadRequest,
  EditMessageRequest,
  EditMessageResponse,
  ForkThreadRequest,
  RestartTerminalRequest,
  DeleteThreadSectionRequest,
  DeleteThreadRequest,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentArchiveThreadsResponse,
  EnvironmentDiffBranchesQuery,
  EnvironmentDiffBranchesResponse,
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  EnvironmentDiffFilesResponse,
  EnvironmentDiffPatchRequest,
  EnvironmentDiffPatchResponse,
  EnvironmentDiffQuery,
  EnvironmentDiffResponse,
  EnvironmentPathsQuery,
  EnvironmentPullRequestResponse,
  EnvironmentStatusQuery,
  EnvironmentStatusResponse,
  HostDirectoryListing,
  HostDirectoryQuery,
  HostCloneDefaultPathQuery,
  HostCloneDefaultPathResponse,
  HostFileListRequest,
  HostFileListResponse,
  HostFileReadRequest,
  HostFileReadResponse,
  HostFileWriteRequest,
  HostFileWriteResponse,
  HostMkdirRequest,
  HostMkdirResponse,
  HostMovePathRequest,
  HostMovePathResponse,
  HostPathListRequest,
  HostPathListResponse,
  HostRemovePathRequest,
  HostRemovePathResponse,
  CreateFilePreviewRequest,
  CreateFilePreviewResponse,
  HostPickFolderRequest,
  HostPickFolderResponse,
  HostPathsExistRequest,
  HostPathsExistResponse,
  HostProviderCliInstallEvent,
  HostProviderCliInstallRequest,
  HostProviderCliStatusResponse,
  HostRetryUpdateResponse,
  ProjectAttachmentContentQuery,
  ProjectAttachmentUploadForm,
  ProjectBranchesQuery,
  ProjectBranchesResponse,
  ProjectCommandsQuery,
  ProjectDefaultExecutionOptionsQuery,
  ProjectFileContentQuery,
  ProjectFilesQuery,
  ProjectListQuery,
  ProjectPathsQuery,
  ProjectResponse,
  ProjectSkillsQuery,
  DeleteSkillRequest,
  SkillListResponse,
  ProjectSkillContentQuery,
  ProjectSkillFilesQuery,
  SkillContentResponse,
  SkillFilesResponse,
  UpdateSkillRequest,
  ProjectWithThreadsResponse,
  PromptHistoryQuery,
  PromptHistoryResponse,
  ReorderPinnedThreadRequest,
  ReorderProjectRequest,
  ReorderQueuedMessageRequest,
  ResolvePendingInteractionRequest,
  ResolveThreadMentionsRequest,
  ResolveThreadMentionsResponse,
  RespondPluginInteractionRequest,
  SendMessageRequest,
  RetryTurnRequest,
  RetryTurnResponse,
  SendMessageResponse,
  SetQueuedMessageGroupBoundaryRequest,
  SendQueuedMessageRequest,
  SendQueuedMessageResponse,
  SidebarBootstrapResponse,
  SystemAttentionResponse,
  SystemConfigReloadResponse,
  SystemConfigResponse,
  SystemCliSkillsStatusQuery,
  SystemCliSkillsStatusResponse,
  SystemInstallCliSkillsRequest,
  SystemInstallCliSkillsResponse,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemProvidersQuery,
  SystemProviderStatesResponse,
  SystemUsageLimitsQuery,
  SystemVersionQuery,
  SystemVersionResponse,
  SystemVoiceTranscriptionForm,
  SystemVoiceTranscriptionResponse,
  TerminalListResponse,
  ThemeCatalogResponse,
  TerminalSession,
  TerminalInputRequest,
  TerminalListQuery,
  TerminalOutputQuery,
  TerminalOutputResponse,
  TerminalResizeRequest,
  ThreadArchiveAllResponse,
  ThreadChildSummaryResponse,
  ThreadEventWaitQuery,
  ThreadEventsQuery,
  ThreadSectionMutationResponse,
  ThreadSectionResponse,
  ThreadFilesRawQuery,
  ThreadGetQuery,
  ThreadHostFileContentQuery,
  ThreadCountQuery,
  ThreadCountResponse,
  ThreadListQuery,
  ThreadListResponse,
  ThreadConversationOutlineResponse,
  ThreadOpenRequest,
  ThreadOpenResponse,
  ThreadPaneActionRequest,
  ThreadPaneActionResponse,
  ThreadPendingInteractionsResponse,
  ThreadRunningResponse,
  QueuedMessageListQuery,
  ThreadQueuedMessageListResponse,
  ThreadResponse,
  ThreadSearchQuery,
  ThreadSearchResponse,
  ThreadStorageContentQuery,
  ThreadStorageFileListResponse,
  ThreadStorageFilesQuery,
  ThreadStorageLocationResponse,
  ThreadStoragePathListResponse,
  ThreadStoragePathsQuery,
  ThreadTimelineQuery,
  ThreadTimelineResponse,
  ThreadWithIncludesResponse,
  TimelineTurnSummaryDetailsQuery,
  TimelineTurnSummaryDetailsResponse,
  UpdateEnvironmentRequest,
  UpdateThreadSectionRequest,
  UpdateTerminalRequest,
  UpdateHostRequest,
  UpdateHostPermissionCeilingRequest,
  UpdateProjectRequest,
  UpdateProjectSourceRequest,
  UpdateThreadRequest,
  UpdateQueuedMessageRequest,
  UploadedPromptAttachment,
  WorkspaceFileListResponse,
  WorkspacePathListResponse,
} from "./api-types.js";
import type {
  ThreadTabsWireResponse,
  UpdateThreadTabsRequest,
} from "./api/thread-tabs.js";
import { updateThreadTabsRequestSchema } from "./api/thread-tabs.js";
import {
  closeTerminalRequestSchema,
  copyProjectAttachmentsRequestSchema,
  createFilePreviewRequestSchema,
  createThreadSectionRequestSchema,
  deleteThreadSectionRequestSchema,
  createTerminalRequestSchema,
  restartTerminalRequestSchema,
  createProjectRequestSchema,
  createHostJoinCodeRequestSchema,
  createProjectSourceRequestSchema,
  createQueuedMessageRequestSchema,
  queuedMessageListQuerySchema,
  updateQueuedMessageRequestSchema,
  createThreadRequestSchema,
  forkThreadRequestSchema,
  deleteThreadRequestSchema,
  environmentActionRequestSchema,
  environmentDiffBranchesQuerySchema,
  environmentDiffFileQuerySchema,
  environmentDiffPatchRequestSchema,
  environmentDiffQuerySchema,
  environmentPathsQuerySchema,
  environmentStatusQuerySchema,
  hostDirectoryQuerySchema,
  hostCloneDefaultPathQuerySchema,
  hostFileListRequestSchema,
  hostFileReadRequestSchema,
  hostFileWriteRequestSchema,
  hostMkdirRequestSchema,
  hostMovePathRequestSchema,
  hostPathListRequestSchema,
  hostRemovePathRequestSchema,
  hostPickFolderRequestSchema,
  hostPathsExistRequestSchema,
  hostProviderCliInstallRequestSchema,
  projectAttachmentContentQuerySchema,
  projectBranchesQuerySchema,
  projectCommandsQuerySchema,
  projectDefaultExecutionOptionsQuerySchema,
  projectFileContentQuerySchema,
  projectFilesQuerySchema,
  projectListQuerySchema,
  projectPathsQuerySchema,
  projectSkillsQuerySchema,
  deleteSkillRequestSchema,
  projectSkillContentQuerySchema,
  projectSkillFilesQuerySchema,
  updateSkillRequestSchema,
  promptHistoryQuerySchema,
  reorderPinnedThreadRequestSchema,
  reorderProjectRequestSchema,
  reorderQueuedMessageRequestSchema,
  resolvePendingInteractionRequestSchema,
  resolveThreadMentionsRequestSchema,
  respondPluginInteractionRequestSchema,
  retryTurnRequestSchema,
  sendMessageRequestSchema,
  editMessageRequestSchema,
  setQueuedMessageGroupBoundaryRequestSchema,
  sendQueuedMessageRequestSchema,
  systemExecutionOptionsQuerySchema,
  systemProvidersQuerySchema,
  systemUsageLimitsQuerySchema,
  systemVersionQuerySchema,
  threadEventWaitQuerySchema,
  threadEventsQuerySchema,
  threadFilesRawQuerySchema,
  threadGetQuerySchema,
  threadHostFileContentQuerySchema,
  threadCountQuerySchema,
  threadListQuerySchema,
  threadOpenRequestSchema,
  threadPaneActionRequestSchema,
  threadSearchQuerySchema,
  threadStorageContentQuerySchema,
  threadStorageFilesQuerySchema,
  threadStoragePathsQuerySchema,
  terminalInputRequestSchema,
  terminalListQuerySchema,
  terminalOutputQuerySchema,
  terminalResizeRequestSchema,
  threadTimelineQuerySchema,
  systemCliSkillsStatusQuerySchema,
  systemInstallCliSkillsRequestSchema,
  timelineTurnSummaryDetailsQuerySchema,
  updateEnvironmentRequestSchema,
  updateHostRequestSchema,
  updateHostPermissionCeilingRequestSchema,
  updateThreadSectionRequestSchema,
  updateTerminalRequestSchema,
  updateProjectRequestSchema,
  updateProjectSourceRequestSchema,
  updateThreadRequestSchema,
} from "./api-types.js";
import type { ApiError } from "./errors.js";

type PathProjectSourceId = { param: { id: string; sourceId: string } };
type PathThreadInteractionId = {
  param: { id: string; interactionId: string };
};

export const publicApiRoutes = {
  projects: {
    list: defineRoute({
      path: "/projects",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ProjectListQuery>(
        projectListQuerySchema,
      ),
      response: jsonResponse<
        ProjectResponse[] | ProjectWithThreadsResponse[]
      >(),
    }),
    create: defineRoute({
      path: "/projects",
      method: "post",
      request: jsonRequest<EmptyInput, CreateProjectRequest>(
        createProjectRequestSchema,
      ),
      response: jsonResponse<ProjectResponse>({ status: 201 }),
    }),
    sidebarBootstrap: defineRoute({
      path: "/sidebar-bootstrap",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SidebarBootstrapResponse>(),
    }),
    get: defineRoute({
      path: "/projects/:id",
      method: "get",
      request: noRequest<PathProjectId>(),
      response: jsonResponse<ProjectResponse>(),
    }),
    update: defineRoute({
      path: "/projects/:id",
      method: "patch",
      request: jsonRequest<PathProjectId, UpdateProjectRequest>(
        updateProjectRequestSchema,
      ),
      response: jsonResponse<ProjectResponse>(),
    }),
    delete: defineRoute({
      path: "/projects/:id",
      method: "delete",
      request: noRequest<PathProjectId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    reorder: defineRoute({
      path: "/projects/:id/order",
      method: "patch",
      request: jsonRequest<PathProjectId, ReorderProjectRequest>(
        reorderProjectRequestSchema,
      ),
      response: jsonResponse<ProjectResponse[]>(),
    }),
    defaultExecutionOptions: defineRoute({
      path: "/projects/:id/default-execution-options",
      method: "get",
      request: queryRequest<PathProjectId, ProjectDefaultExecutionOptionsQuery>(
        projectDefaultExecutionOptionsQuerySchema,
      ),
      response: jsonResponse<ProjectExecutionDefaults | null>(),
    }),
    promptHistory: defineRoute({
      path: "/projects/:id/prompt-history",
      method: "get",
      request: optionalQueryRequest<PathProjectId, PromptHistoryQuery>(
        promptHistoryQuerySchema,
      ),
      response: jsonResponse<PromptHistoryResponse>(),
    }),
    createSource: defineRoute({
      path: "/projects/:id/sources",
      method: "post",
      request: jsonRequest<PathProjectId, CreateProjectSourceRequest>(
        createProjectSourceRequestSchema,
      ),
      response: jsonResponse<ProjectSource>({ status: 201 }),
    }),
    updateSource: defineRoute({
      path: "/projects/:id/sources/:sourceId",
      method: "patch",
      request: jsonRequest<PathProjectSourceId, UpdateProjectSourceRequest>(
        updateProjectSourceRequestSchema,
      ),
      response: jsonResponse<ProjectSource>(),
    }),
    deleteSource: defineRoute({
      path: "/projects/:id/sources/:sourceId",
      method: "delete",
      request: noRequest<PathProjectSourceId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    files: defineRoute({
      path: "/projects/:id/files",
      method: "get",
      request: queryRequest<PathProjectId, ProjectFilesQuery>(
        projectFilesQuerySchema,
      ),
      response: jsonResponse<WorkspaceFileListResponse>(),
    }),
    fileContent: defineRoute({
      path: "/projects/:id/files/content",
      method: "get",
      request: queryRequest<PathProjectId, ProjectFileContentQuery>(
        projectFileContentQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
    paths: defineRoute({
      path: "/projects/:id/paths",
      method: "get",
      request: queryRequest<PathProjectId, ProjectPathsQuery>(
        projectPathsQuerySchema,
      ),
      response: jsonResponse<WorkspacePathListResponse>(),
    }),
    commands: defineRoute({
      path: "/projects/:id/commands",
      method: "get",
      request: queryRequest<PathProjectId, ProjectCommandsQuery>(
        projectCommandsQuerySchema,
      ),
      response: jsonResponse<CommandListResponse>(),
    }),
    skills: defineRoute({
      path: "/projects/:id/skills",
      method: "get",
      request: queryRequest<PathProjectId, ProjectSkillsQuery>(
        projectSkillsQuerySchema,
      ),
      response: jsonResponse<SkillListResponse>(),
    }),
    deleteSkill: defineRoute({
      path: "/projects/:id/skills",
      method: "delete",
      request: jsonRequest<PathProjectId, DeleteSkillRequest>(
        deleteSkillRequestSchema,
      ),
      response: jsonResponse<{ deletedPath: string }>(),
    }),
    skillContent: defineRoute({
      path: "/projects/:id/skills/content",
      method: "get",
      request: queryRequest<PathProjectId, ProjectSkillContentQuery>(
        projectSkillContentQuerySchema,
      ),
      response: jsonResponse<SkillContentResponse>(),
    }),
    skillFiles: defineRoute({
      path: "/projects/:id/skills/files",
      method: "get",
      request: queryRequest<PathProjectId, ProjectSkillFilesQuery>(
        projectSkillFilesQuerySchema,
      ),
      response: jsonResponse<SkillFilesResponse>(),
    }),
    updateSkill: defineRoute({
      path: "/projects/:id/skills/content",
      method: "patch",
      request: jsonRequest<PathProjectId, UpdateSkillRequest>(
        updateSkillRequestSchema,
      ),
      response: jsonResponse<{ filePath: string; revision: string }>(),
    }),
    branches: defineRoute({
      path: "/projects/:id/branches",
      method: "get",
      request: queryRequest<PathProjectId, ProjectBranchesQuery>(
        projectBranchesQuerySchema,
      ),
      response: jsonResponse<ProjectBranchesResponse>(),
    }),
    branchOptions: defineRoute({
      path: "/projects/:id/branch-options",
      method: "get",
      request: queryRequest<PathProjectId, ProjectBranchesQuery>(
        projectBranchesQuerySchema,
      ),
      response: jsonResponse<ProjectBranchesResponse>(),
    }),
    uploadAttachment: defineRoute({
      path: "/projects/:id/attachments",
      method: "post",
      request: formRequest<PathProjectId, ProjectAttachmentUploadForm>(),
      response: jsonResponse<UploadedPromptAttachment>({ status: 201 }),
    }),
    copyAttachments: defineRoute({
      path: "/projects/:id/attachments/copy",
      method: "post",
      request: jsonRequest<PathProjectId, CopyProjectAttachmentsRequest>(
        copyProjectAttachmentsRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    attachmentContent: defineRoute({
      path: "/projects/:id/attachments/content",
      method: "get",
      request: queryRequest<PathProjectId, ProjectAttachmentContentQuery>(
        projectAttachmentContentQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  files: {
    read: defineRoute({
      path: "/files/read",
      method: "post",
      request: jsonRequest<EmptyInput, HostFileReadRequest>(
        hostFileReadRequestSchema,
      ),
      response: jsonResponse<HostFileReadResponse>(),
    }),
    write: defineRoute({
      path: "/files/write",
      method: "post",
      request: jsonRequest<EmptyInput, HostFileWriteRequest>(
        hostFileWriteRequestSchema,
      ),
      response: jsonResponse<HostFileWriteResponse>(),
    }),
    list: defineRoute({
      path: "/files/list",
      method: "post",
      request: jsonRequest<EmptyInput, HostFileListRequest>(
        hostFileListRequestSchema,
      ),
      response: jsonResponse<HostFileListResponse>(),
    }),
    listPaths: defineRoute({
      path: "/files/paths",
      method: "post",
      request: jsonRequest<EmptyInput, HostPathListRequest>(
        hostPathListRequestSchema,
      ),
      response: jsonResponse<HostPathListResponse>(),
    }),
    mkdir: defineRoute({
      path: "/files/mkdir",
      method: "post",
      request: jsonRequest<EmptyInput, HostMkdirRequest>(
        hostMkdirRequestSchema,
      ),
      response: jsonResponse<HostMkdirResponse>(),
    }),
    move: defineRoute({
      path: "/files/move",
      method: "post",
      request: jsonRequest<EmptyInput, HostMovePathRequest>(
        hostMovePathRequestSchema,
      ),
      response: jsonResponse<HostMovePathResponse>(),
    }),
    remove: defineRoute({
      path: "/files/remove",
      method: "post",
      request: jsonRequest<EmptyInput, HostRemovePathRequest>(
        hostRemovePathRequestSchema,
      ),
      response: jsonResponse<HostRemovePathResponse>(),
    }),
    createPreview: defineRoute({
      path: "/files/previews",
      method: "post",
      request: jsonRequest<EmptyInput, CreateFilePreviewRequest>(
        createFilePreviewRequestSchema,
      ),
      response: jsonResponse<CreateFilePreviewResponse>(),
    }),
  },

  filePreviews: {
    content: defineRoute({
      path: "/file-previews/:id/:filePath{.+}",
      method: "get",
      request: noRequest<PathPreviewAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  desktopBrowsers: {
    listInstances: defineRoute({
      path: "/desktop-browsers/instances",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserHostRequest>(
        desktopBrowserHostRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserInstances>(),
    }),
    listTabs: defineRoute({
      path: "/desktop-browsers/tabs",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserScope>(
        desktopBrowserScopeSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserTabs>(),
    }),
    createTab: defineRoute({
      path: "/desktop-browsers/create",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserCreateInput>(
        desktopBrowserCreateRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserCreated>(),
    }),
    acquireControl: defineRoute({
      path: "/desktop-browsers/acquire",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserAcquireInput>(
        desktopBrowserAcquireRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserLease>(),
    }),
    openConnection: defineRoute({
      path: "/desktop-browsers/connection",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserLeaseRequest>(
        desktopBrowserLeaseRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserConnection>(),
    }),
    releaseControl: defineRoute({
      path: "/desktop-browsers/release",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserLeaseRequest>(
        desktopBrowserLeaseRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    closeTab: defineRoute({
      path: "/desktop-browsers/close",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserTabRequest>(
        desktopBrowserTabRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    revealTab: defineRoute({
      path: "/desktop-browsers/reveal",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserTabRequest>(
        desktopBrowserTabRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    captureTab: defineRoute({
      path: "/desktop-browsers/capture",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserTabRequest>(
        desktopBrowserTabRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserCapture>(),
    }),
  },

  hosts: {
    createJoinCode: defineRoute({
      path: "/hosts/join-codes",
      method: "post",
      request: jsonRequest<EmptyInput, CreateHostJoinCodeRequest>(
        createHostJoinCodeRequestSchema,
      ),
      response: jsonResponse<CreateHostJoinCodeResponse>({ status: 201 }),
    }),
    list: defineRoute({
      path: "/hosts",
      method: "get",
      request: noRequest(),
      response: jsonResponse<Host[]>(),
    }),
    get: defineRoute({
      path: "/hosts/:id",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<Host>(),
    }),
    update: defineRoute({
      path: "/hosts/:id",
      method: "patch",
      request: jsonRequest<PathId, UpdateHostRequest>(updateHostRequestSchema),
      response: jsonResponse<Host>(),
    }),
    updatePermissionCeiling: defineRoute({
      path: "/hosts/:id/permission-ceiling",
      method: "patch",
      request: jsonRequest<PathId, UpdateHostPermissionCeilingRequest>(
        updateHostPermissionCeilingRequestSchema,
      ),
      response: jsonResponse<Host>(),
    }),
    retryUpdate: defineRoute({
      path: "/hosts/:id/retry-update",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<HostRetryUpdateResponse>(),
    }),
    delete: defineRoute({
      path: "/hosts/:id",
      method: "delete",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    directory: defineRoute({
      path: "/hosts/:id/directory",
      method: "get",
      request: queryRequest<PathId, HostDirectoryQuery>(
        hostDirectoryQuerySchema,
      ),
      response: jsonResponse<HostDirectoryListing>(),
    }),
    cloneDefaultPath: defineRoute({
      path: "/hosts/:id/clone-default-path",
      method: "get",
      request: queryRequest<PathId, HostCloneDefaultPathQuery>(
        hostCloneDefaultPathQuerySchema,
      ),
      response: jsonResponse<HostCloneDefaultPathResponse>(),
    }),
    pathsExist: defineRoute({
      path: "/hosts/:id/paths/exist",
      method: "post",
      request: jsonRequest<PathId, HostPathsExistRequest>(
        hostPathsExistRequestSchema,
      ),
      response: jsonResponse<HostPathsExistResponse>(),
    }),
    pickFolder: defineRoute({
      path: "/hosts/:id/pick-folder",
      method: "post",
      request: jsonRequest<PathId, HostPickFolderRequest>(
        hostPickFolderRequestSchema,
      ),
      response: jsonResponse<HostPickFolderResponse>(),
    }),
    providerCliStatus: defineRoute({
      path: "/hosts/:id/provider-clis/status",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<HostProviderCliStatusResponse>(),
    }),
    providerCliInstall: defineRoute({
      path: "/hosts/:id/provider-clis/install",
      method: "post",
      request: jsonRequest<PathId, HostProviderCliInstallRequest>(
        hostProviderCliInstallRequestSchema,
      ),
      response: textResponse<HostProviderCliInstallEvent>(),
    }),
  },

  terminals: {
    list: defineRoute({
      path: "/terminals",
      method: "get",
      request: queryRequest<EmptyInput, TerminalListQuery>(
        terminalListQuerySchema,
      ),
      response: jsonResponse<TerminalListResponse>(),
    }),
    create: defineRoute({
      path: "/terminals",
      method: "post",
      request: jsonRequest<EmptyInput, CreateTerminalRequest>(
        createTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>({ status: 201 }),
    }),
    get: defineRoute({
      path: "/terminals/:terminalId",
      method: "get",
      request: noRequest<PathTerminal>(),
      response: jsonResponse<TerminalSession>(),
    }),
    update: defineRoute({
      path: "/terminals/:terminalId",
      method: "patch",
      request: jsonRequest<PathTerminal, UpdateTerminalRequest>(
        updateTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    restart: defineRoute({
      path: "/terminals/:terminalId/restart",
      method: "post",
      request: jsonRequest<PathTerminal, RestartTerminalRequest>(
        restartTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>({ status: 201 }),
    }),
    close: defineRoute({
      path: "/terminals/:terminalId/close",
      method: "post",
      request: jsonRequest<PathTerminal, CloseTerminalRequest>(
        closeTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    input: defineRoute({
      path: "/terminals/:terminalId/input",
      method: "post",
      request: jsonRequest<PathTerminal, TerminalInputRequest>(
        terminalInputRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    resize: defineRoute({
      path: "/terminals/:terminalId/resize",
      method: "post",
      request: jsonRequest<PathTerminal, TerminalResizeRequest>(
        terminalResizeRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    output: defineRoute({
      path: "/terminals/:terminalId/output",
      method: "get",
      request: optionalQueryRequest<PathTerminal, TerminalOutputQuery>(
        terminalOutputQuerySchema,
      ),
      response: jsonResponse<TerminalOutputResponse>(),
    }),
  },

  environments: {
    get: defineRoute({
      path: "/environments/:id",
      method: "get",
      request: noRequest<PathId>(),
      response: [
        jsonResponse<Environment>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    update: defineRoute({
      path: "/environments/:id",
      method: "patch",
      request: jsonRequest<PathId, UpdateEnvironmentRequest>(
        updateEnvironmentRequestSchema,
      ),
      response: jsonResponse<Environment>(),
    }),
    status: defineRoute({
      path: "/environments/:id/status",
      method: "get",
      request: queryRequest<PathId, EnvironmentStatusQuery>(
        environmentStatusQuerySchema,
      ),
      response: jsonResponse<EnvironmentStatusResponse>(),
    }),
    pullRequest: defineRoute({
      path: "/environments/:id/pull-request",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<EnvironmentPullRequestResponse>(),
    }),
    diff: defineRoute({
      path: "/environments/:id/diff",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffQuery>(
        environmentDiffQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffResponse>(),
    }),
    diffFiles: defineRoute({
      path: "/environments/:id/diff/files",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffQuery>(
        environmentDiffQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffFilesResponse>(),
    }),
    diffPatch: defineRoute({
      path: "/environments/:id/diff/patch",
      method: "post",
      request: jsonRequest<PathId, EnvironmentDiffPatchRequest>(
        environmentDiffPatchRequestSchema,
      ),
      response: jsonResponse<EnvironmentDiffPatchResponse>(),
    }),
    diffFile: defineRoute({
      path: "/environments/:id/diff/file",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffFileQuery>(
        environmentDiffFileQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffFileResponse>(),
    }),
    diffBranches: defineRoute({
      path: "/environments/:id/diff/branches",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffBranchesQuery>(
        environmentDiffBranchesQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffBranchesResponse>(),
    }),
    paths: defineRoute({
      path: "/environments/:id/paths",
      method: "get",
      request: queryRequest<PathId, EnvironmentPathsQuery>(
        environmentPathsQuerySchema,
      ),
      response: jsonResponse<WorkspacePathListResponse>(),
    }),
    actions: defineRoute({
      path: "/environments/:id/actions",
      method: "post",
      request: jsonRequest<PathId, EnvironmentActionRequest>(
        environmentActionRequestSchema,
      ),
      response: [
        jsonResponse<EnvironmentActionResponse>(),
        jsonResponse<EnvironmentActionApiError>({ status: 409 }),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    archiveThreads: defineRoute({
      path: "/environments/:id/archive-threads",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<EnvironmentArchiveThreadsResponse>(),
    }),
  },

  threadSections: {
    create: defineRoute({
      path: "/thread-sections",
      method: "post",
      request: jsonRequest<EmptyInput, CreateThreadSectionRequest>(
        createThreadSectionRequestSchema,
      ),
      response: [
        jsonResponse<ThreadSectionResponse>({ status: 201 }),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    update: defineRoute({
      path: "/thread-sections",
      method: "patch",
      request: jsonRequest<EmptyInput, UpdateThreadSectionRequest>(
        updateThreadSectionRequestSchema,
      ),
      response: [
        jsonResponse<ThreadSectionMutationResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    delete: defineRoute({
      path: "/thread-sections",
      method: "delete",
      request: jsonRequest<EmptyInput, DeleteThreadSectionRequest>(
        deleteThreadSectionRequestSchema,
      ),
      response: [
        jsonResponse<ThreadSectionMutationResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
  },

  threads: {
    list: defineRoute({
      path: "/threads",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ThreadListQuery>(
        threadListQuerySchema,
      ),
      response: jsonResponse<ThreadListResponse>(),
    }),
    /**
     * Grouped `SELECT count(*)` over threads. Exists because a plugin gate
     * that limits concurrency must count without loading: `threads.list`
     * would page rows into memory and still miscount past its limit.
     */
    count: defineRoute({
      path: "/threads/count",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ThreadCountQuery>(
        threadCountQuerySchema,
      ),
      response: jsonResponse<ThreadCountResponse>(),
    }),
    /**
     * The threads occupying capacity right now, as rows rather than a count.
     * A limiter needs to know *which* threads are running to hold several
     * pools at once — `threads.count` answers one pool per request and cannot
     * reconcile a global limit with a per-host one from separate counts.
     */
    running: defineRoute({
      path: "/threads/running",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ThreadRunningResponse>(),
    }),
    search: defineRoute({
      path: "/threads/search",
      method: "get",
      request: queryRequest<EmptyInput, ThreadSearchQuery>(
        threadSearchQuerySchema,
      ),
      response: jsonResponse<ThreadSearchResponse>(),
    }),
    resolveMentions: defineRoute({
      path: "/threads/resolve-mentions",
      method: "post",
      request: jsonRequest<EmptyInput, ResolveThreadMentionsRequest>(
        resolveThreadMentionsRequestSchema,
      ),
      response: jsonResponse<ResolveThreadMentionsResponse>(),
    }),
    create: defineRoute({
      path: "/threads",
      method: "post",
      request: jsonRequest<EmptyInput, CreateThreadRequest>(
        createThreadRequestSchema,
      ),
      response: jsonResponse<ThreadResponse>({ status: 201 }),
    }),
    fork: defineRoute({
      path: "/threads/fork",
      method: "post",
      request: jsonRequest<EmptyInput, ForkThreadRequest>(
        forkThreadRequestSchema,
      ),
      response: jsonResponse<ThreadResponse>({ status: 201 }),
    }),
    get: defineRoute({
      path: "/threads/:id",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadGetQuery>(
        threadGetQuerySchema,
      ),
      response: jsonResponse<ThreadResponse | ThreadWithIncludesResponse>(),
    }),
    update: defineRoute({
      path: "/threads/:id",
      method: "patch",
      request: jsonRequest<PathId, UpdateThreadRequest>(
        updateThreadRequestSchema,
      ),
      response: jsonResponse<ThreadResponse>(),
    }),
    delete: defineRoute({
      path: "/threads/:id",
      method: "delete",
      request: jsonRequest<PathId, DeleteThreadRequest>(
        deleteThreadRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    childSummary: defineRoute({
      path: "/threads/:id/child-summary",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadChildSummaryResponse>(),
    }),
    send: defineRoute({
      path: "/threads/:id/send",
      method: "post",
      request: jsonRequest<PathId, SendMessageRequest>(
        sendMessageRequestSchema,
      ),
      response: jsonResponse<SendMessageResponse>(),
    }),
    editMessage: defineRoute({
      path: "/threads/:id/edit-message",
      method: "post",
      request: jsonRequest<PathId, EditMessageRequest>(
        editMessageRequestSchema,
      ),
      response: jsonResponse<EditMessageResponse>(),
    }),
    /**
     * Retry a failed turn: re-submit it by reference, as an ordinary dispatch
     * attempt. `turnRequestId` null means the thread's most recent turn, whose
     * failure is what put the thread in `error`.
     */
    retry: defineRoute({
      path: "/threads/:id/retry",
      method: "post",
      request: jsonRequest<PathId, RetryTurnRequest>(retryTurnRequestSchema),
      response: jsonResponse<RetryTurnResponse>(),
    }),
    queuedMessages: defineRoute({
      path: "/threads/:id/queued-messages",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
    /**
     * Create a queued message; senderThreadId preserves agent-to-agent context
     * until send time.
     */
    createQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages",
      method: "post",
      request: jsonRequest<PathId, CreateQueuedMessageRequest>(
        createQueuedMessageRequestSchema,
      ),
      response: jsonResponse<ThreadQueuedMessage>({ status: 201 }),
    }),
    updateQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId",
      method: "patch",
      request: jsonRequest<
        PathThreadAndQueuedMessage,
        UpdateQueuedMessageRequest
      >(updateQueuedMessageRequestSchema),
      response: jsonResponse<ThreadQueuedMessage>(),
    }),
    sendQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/send",
      method: "post",
      request: jsonRequest<
        PathThreadAndQueuedMessage,
        SendQueuedMessageRequest
      >(sendQueuedMessageRequestSchema),
      response: jsonResponse<SendQueuedMessageResponse>(),
    }),
    reorderQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/order",
      method: "patch",
      request: jsonRequest<
        PathThreadAndQueuedMessage,
        ReorderQueuedMessageRequest
      >(reorderQueuedMessageRequestSchema),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
    setQueuedMessageGroupBoundary: defineRoute({
      path: "/threads/:id/queued-messages/group-boundary",
      method: "patch",
      request: jsonRequest<PathId, SetQueuedMessageGroupBoundaryRequest>(
        setQueuedMessageGroupBoundaryRequestSchema,
      ),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
    promptHistory: defineRoute({
      path: "/threads/:id/prompt-history",
      method: "get",
      request: optionalQueryRequest<PathId, PromptHistoryQuery>(
        promptHistoryQuerySchema,
      ),
      response: jsonResponse<PromptHistoryResponse>(),
    }),
    deleteQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId",
      method: "delete",
      request: noRequest<PathThreadAndQueuedMessage>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    stop: defineRoute({
      path: "/threads/:id/stop",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    compact: defineRoute({
      path: "/threads/:id/compact",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    clearContext: defineRoute({
      path: "/threads/:id/context/clear",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    cancelPlan: defineRoute({
      path: "/threads/:id/plan/cancel",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    clearGoal: defineRoute({
      path: "/threads/:id/goal/clear",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    open: defineRoute({
      path: "/threads/:id/open",
      method: "post",
      request: jsonRequest<PathId, ThreadOpenRequest>(threadOpenRequestSchema),
      response: jsonResponse<ThreadOpenResponse>(),
    }),
    paneAction: defineRoute({
      path: "/threads/:id/pane-action",
      method: "post",
      request: jsonRequest<PathId, ThreadPaneActionRequest>(
        threadPaneActionRequestSchema,
      ),
      response: jsonResponse<ThreadPaneActionResponse>(),
    }),
    tabs: defineRoute({
      path: "/threads/:id/tabs",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadTabsWireResponse>(),
    }),
    updateTabs: defineRoute({
      path: "/threads/:id/tabs",
      method: "put",
      request: jsonRequest<PathId, UpdateThreadTabsRequest>(
        updateThreadTabsRequestSchema,
      ),
      response: [
        jsonResponse<ThreadTabsWireResponse>(),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    pin: defineRoute({
      path: "/threads/:id/pin",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    unpin: defineRoute({
      path: "/threads/:id/unpin",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    pinOrder: defineRoute({
      path: "/threads/:id/pin-order",
      method: "patch",
      request: jsonRequest<PathId, ReorderPinnedThreadRequest>(
        reorderPinnedThreadRequestSchema,
      ),
      response: jsonResponse<ThreadListResponse>(),
    }),
    interactions: defineRoute({
      path: "/threads/:id/interactions",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadPendingInteractionsResponse>(),
    }),
    interaction: defineRoute({
      path: "/threads/:id/interactions/:interactionId",
      method: "get",
      request: noRequest<PathThreadInteractionId>(),
      response: jsonResponse<PendingInteraction>(),
    }),
    resolveInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/resolve",
      method: "post",
      request: jsonRequest<
        PathThreadInteractionId,
        ResolvePendingInteractionRequest
      >(resolvePendingInteractionRequestSchema),
      response: jsonResponse<PendingInteraction>(),
    }),
    respondToInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/respond",
      method: "post",
      request: jsonRequest<
        PathThreadInteractionId,
        RespondPluginInteractionRequest
      >(respondPluginInteractionRequestSchema),
      response: jsonResponse<PendingInteraction>(),
    }),
    cancelInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/cancel",
      method: "post",
      request: noRequest<PathThreadInteractionId>(),
      response: jsonResponse<PendingInteraction>(),
    }),
    archive: defineRoute({
      path: "/threads/:id/archive",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    archiveAll: defineRoute({
      path: "/threads/:id/archive-all",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadArchiveAllResponse>(),
    }),
    unarchive: defineRoute({
      path: "/threads/:id/unarchive",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    read: defineRoute({
      path: "/threads/:id/read",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    unread: defineRoute({
      path: "/threads/:id/unread",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    timeline: defineRoute({
      path: "/threads/:id/timeline",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadTimelineQuery>(
        threadTimelineQuerySchema,
      ),
      response: jsonResponse<ThreadTimelineResponse>(),
    }),
    conversationOutline: defineRoute({
      path: "/threads/:id/conversation-outline",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadConversationOutlineResponse>(),
    }),
    timelineTurnSummaryDetails: defineRoute({
      path: "/threads/:id/timeline/turn-summary-details",
      method: "get",
      request: queryRequest<PathId, TimelineTurnSummaryDetailsQuery>(
        timelineTurnSummaryDetailsQuerySchema,
      ),
      response: jsonResponse<TimelineTurnSummaryDetailsResponse>(),
    }),
    output: defineRoute({
      path: "/threads/:id/output",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<{ output: string | null }>(),
    }),
    events: defineRoute({
      path: "/threads/:id/events",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadEventsQuery>(
        threadEventsQuerySchema,
      ),
      response: jsonResponse<ThreadEventRow[]>(),
    }),
    eventWait: defineRoute({
      path: "/threads/:id/events/wait",
      method: "get",
      request: queryRequest<PathId, ThreadEventWaitQuery>(
        threadEventWaitQuerySchema,
      ),
      response: jsonResponse<ThreadEventRow | null>(),
    }),
    defaultExecutionOptions: defineRoute({
      path: "/threads/:id/default-execution-options",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ResolvedThreadExecutionOptions | null>(),
    }),
    storageFiles: defineRoute({
      path: "/threads/:id/thread-storage/files",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadStorageFilesQuery>(
        threadStorageFilesQuerySchema,
      ),
      response: jsonResponse<ThreadStorageFileListResponse>(),
    }),
    storageLocation: defineRoute({
      path: "/threads/:id/thread-storage/location",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadStorageLocationResponse>(),
    }),
    storageFile: defineRoute({
      path: "/threads/:id/thread-storage/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathThreadAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    storagePaths: defineRoute({
      path: "/threads/:id/thread-storage/paths",
      method: "get",
      request: queryRequest<PathId, ThreadStoragePathsQuery>(
        threadStoragePathsQuerySchema,
      ),
      response: jsonResponse<ThreadStoragePathListResponse>(),
    }),
    storageContent: defineRoute({
      path: "/threads/:id/thread-storage/content",
      method: "get",
      request: queryRequest<PathId, ThreadStorageContentQuery>(
        threadStorageContentQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
    hostFileContent: defineRoute({
      path: "/threads/:id/host-files/content",
      method: "get",
      request: queryRequest<PathId, ThreadHostFileContentQuery>(
        threadHostFileContentQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
    worktreeFile: defineRoute({
      path: "/threads/:id/worktree/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathThreadAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    rawFile: defineRoute({
      path: "/threads/:id/files/raw",
      method: "get",
      request: queryRequest<PathId, ThreadFilesRawQuery>(
        threadFilesRawQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  queue: {
    /**
     * Every live queued row, optionally narrowed to one thread or one
     * wait holder. Cross-thread because "what is queued right now" is a
     * whole-workspace question (`bb thread queue list` with no thread, a
     * limiter plugin's own bookkeeping, a router recovering its rows after a
     * restart) that no single thread's list can answer.
     */
    list: defineRoute({
      path: "/queued-messages",
      method: "get",
      request: optionalQueryRequest<EmptyInput, QueuedMessageListQuery>(
        queuedMessageListQuerySchema,
      ),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
  },

  system: {
    attention: defineRoute({
      path: "/system/attention",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemAttentionResponse>(),
    }),
    config: defineRoute({
      path: "/system/config",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemConfigResponse>(),
    }),
    generalSettings: defineRoute({
      path: "/settings/general",
      method: "put",
      request: jsonRequest<EmptyInput, AppSettings>(appSettingsSchema),
      response: jsonResponse<AppSettings>(),
    }),
    keyboardSettings: defineRoute({
      path: "/settings/keyboard",
      method: "put",
      request: jsonRequest<EmptyInput, AppKeybindingOverrides>(
        appKeybindingOverridesSchema,
      ),
      response: jsonResponse<AppKeybindingOverrides>(),
    }),
    experiments: defineRoute({
      path: "/settings/experiments",
      method: "put",
      request: jsonRequest<EmptyInput, Experiments>(experimentsSchema),
      response: jsonResponse<Experiments>(),
    }),
    appearance: defineRoute({
      path: "/settings/appearance",
      method: "put",
      request: jsonRequest<EmptyInput, AppThemeSelection>(
        appThemeSelectionSchema,
      ),
      response: jsonResponse<AppTheme>(),
    }),
    themes: defineRoute({
      path: "/settings/themes",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ThemeCatalogResponse>(),
    }),
    reloadConfig: defineRoute({
      path: "/system/config/reload",
      method: "post",
      request: noRequest(),
      response: jsonResponse<SystemConfigReloadResponse>(),
    }),
    cliSkillsStatus: defineRoute({
      path: "/system/cli-skills",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemCliSkillsStatusQuery>(
        systemCliSkillsStatusQuerySchema,
      ),
      response: jsonResponse<SystemCliSkillsStatusResponse>(),
    }),
    installCliSkills: defineRoute({
      path: "/system/cli-skills/install",
      method: "post",
      request: jsonRequest<EmptyInput, SystemInstallCliSkillsRequest>(
        systemInstallCliSkillsRequestSchema,
      ),
      response: jsonResponse<SystemInstallCliSkillsResponse>(),
    }),
    executionOptions: defineRoute({
      path: "/system/execution-options",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemExecutionOptionsQuery>(
        systemExecutionOptionsQuerySchema,
      ),
      response: jsonResponse<SystemExecutionOptionsResponse>(),
    }),
    providers: defineRoute({
      path: "/system/providers",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemProvidersQuery>(
        systemProvidersQuerySchema,
      ),
      response: jsonResponse<SystemProviderInfo[]>(),
    }),
    providerLogo: defineRoute({
      path: "/system/providers/:id/logo",
      method: "get",
      request: noRequest<PathId>(),
      response: binaryResponse<Uint8Array>(),
    }),
    providerStates: defineRoute({
      path: "/system/providers/state",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemProvidersQuery>(
        systemProvidersQuerySchema,
      ),
      response: jsonResponse<SystemProviderStatesResponse>(),
    }),
    usageLimits: defineRoute({
      path: "/system/usage-limits",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemUsageLimitsQuery>(
        systemUsageLimitsQuerySchema,
      ),
      response: jsonResponse<ProviderUsageResponse>(),
    }),
    voiceTranscription: defineRoute({
      path: "/system/voice-transcription",
      method: "post",
      request: formRequest<EmptyInput, SystemVoiceTranscriptionForm>(),
      response: jsonResponse<SystemVoiceTranscriptionResponse>(),
    }),
    version: defineRoute({
      path: "/system/version",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemVersionQuery>(
        systemVersionQuerySchema,
      ),
      response: jsonResponse<SystemVersionResponse>(),
    }),
  },
};

export type PublicApiSchema = ApiSchemaFromRouteDescriptors<
  typeof publicApiRoutes
>;

export type PublicApiRoutes = Hono<{}, PublicApiSchema, "/">;
