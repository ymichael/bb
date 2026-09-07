import type {
  CommandListResponse,
  CopyProjectAttachmentsRequest,
  CreateProjectRequest,
  CreateProjectSourceRequest,
  ProjectBranchesResponse,
  ProjectBranchesQuery,
  ProjectCommandsQuery,
  ProjectFileContentQuery,
  ProjectFilesQuery,
  ProjectResponse,
  ProjectWithThreadsResponse,
  ProjectListQuery,
  ProjectPathsQuery,
  PromptHistoryResponse,
  PromptHistoryQuery,
  ReorderProjectRequest,
  SidebarBootstrapResponse,
  UpdateProjectRequest,
  UpdateProjectSourceRequest,
  UploadedPromptAttachment,
  WorkspacePathListResponse,
  WorkspaceFileListResponse,
} from "@bb/server-contract";
import { uploadedPromptAttachmentSchema } from "@bb/server-contract";
import type { ProjectExecutionDefaults, ProjectSource } from "@bb/domain";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface ProjectListArgs {
  include?: ProjectListQuery["include"];
  includePersonal?: boolean;
  signal?: AbortSignal;
}

export interface ProjectCreateArgs extends CreateProjectRequest {}

export interface ProjectGetArgs {
  projectId: string;
  signal?: AbortSignal;
}

export interface ProjectUpdateArgs extends UpdateProjectRequest {
  projectId: string;
}

export interface ProjectDeleteArgs {
  projectId: string;
}

export interface ProjectReorderArgs extends ReorderProjectRequest {
  projectId: string;
}

export interface ProjectPromptHistoryArgs extends PromptHistoryQuery {
  projectId: string;
  signal?: AbortSignal;
}

export type ProjectWorkspaceRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export type ProjectFilesArgs = ProjectWorkspaceRoutingArgs &
  Omit<ProjectFilesQuery, "environmentId" | "hostId"> & {
    projectId: string;
    signal?: AbortSignal;
  };

export type ProjectPathsArgs = ProjectWorkspaceRoutingArgs &
  Omit<ProjectPathsQuery, "environmentId" | "hostId"> & {
    projectId: string;
    signal?: AbortSignal;
  };

export type ProjectCommandsArgs = ProjectWorkspaceRoutingArgs &
  Omit<ProjectCommandsQuery, "environmentId" | "hostId"> & {
    projectId: string;
    signal?: AbortSignal;
  };

export type ProjectFileContentArgs = ProjectWorkspaceRoutingArgs &
  Omit<ProjectFileContentQuery, "environmentId" | "hostId"> & {
    projectId: string;
    signal?: AbortSignal;
  };

export interface ProjectBranchesArgs extends ProjectBranchesQuery {
  projectId: string;
  signal?: AbortSignal;
}

export interface ProjectDefaultExecutionOptionsArgs {
  projectId: string;
  signal?: AbortSignal;
}

export interface ProjectSidebarBootstrapArgs {
  signal?: AbortSignal;
}

export interface ProjectAttachmentFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly name: string;
  readonly type?: string;
}

export type ProjectAttachmentUploadFile =
  | ArrayBuffer
  | Blob
  | ProjectAttachmentFileLike
  | Uint8Array;

interface ProjectAttachmentUploadArgsBase {
  mimeType?: string;
  projectId: string;
}

export type ProjectAttachmentUploadArgs = ProjectAttachmentUploadArgsBase &
  (
    | {
        clientFile: ProjectAttachmentFileLike;
        filename?: string;
      }
    | {
        clientFile: ArrayBuffer | Blob | Uint8Array;
        filename: string;
      }
  );

export interface ProjectAttachmentReadArgs {
  path: string;
  projectId: string;
  signal?: AbortSignal;
}

export interface ProjectAttachmentCopyArgs extends CopyProjectAttachmentsRequest {
  projectId: string;
}

export type ProjectSourceAddArgs = CreateProjectSourceRequest & {
  projectId: string;
};

export interface ProjectSourceUpdateArgs extends UpdateProjectSourceRequest {
  projectId: string;
  sourceId: string;
}

export interface ProjectSourceDeleteArgs {
  projectId: string;
  sourceId: string;
}

export type ProjectBranchesResult = ProjectBranchesResponse;
export interface ProjectAttachmentReadResult {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
}
export type ProjectAttachmentUploadResult = UploadedPromptAttachment;
export type ProjectCommandsResult = CommandListResponse;
export type ProjectCreateResult = ProjectResponse;
export type ProjectDefaultExecutionOptionsResult = ProjectExecutionDefaults | null;
export type ProjectDeleteResult = { ok: true };
export interface ProjectFileContentResult {
  content: string;
  contentEncoding: "utf8" | "base64";
  mimeType: string;
  sizeBytes: number;
}
export type ProjectFilesResult = WorkspaceFileListResponse;
export type ProjectGetResult = ProjectResponse;
export type ProjectListResult =
  | ProjectResponse[]
  | ProjectWithThreadsResponse[];
export type ProjectPathsResult = WorkspacePathListResponse;
export type ProjectPromptHistoryResult = PromptHistoryResponse;
export type ProjectReorderResult = ProjectResponse[];
export type ProjectSidebarBootstrapResult = SidebarBootstrapResponse;
export type ProjectSourceAddResult = ProjectSource;
export type ProjectSourceDeleteResult = { ok: true };
export type ProjectSourceUpdateResult = ProjectSource;
export type ProjectUpdateResult = ProjectResponse;

export interface ProjectSourcesArea {
  add(args: ProjectSourceAddArgs): Promise<ProjectSourceAddResult>;
  delete(args: ProjectSourceDeleteArgs): Promise<ProjectSourceDeleteResult>;
  update(args: ProjectSourceUpdateArgs): Promise<ProjectSourceUpdateResult>;
}

export interface ProjectAttachmentsArea {
  copy(args: ProjectAttachmentCopyArgs): Promise<void>;
  read(args: ProjectAttachmentReadArgs): Promise<ProjectAttachmentReadResult>;
  upload(
    args: ProjectAttachmentUploadArgs,
  ): Promise<ProjectAttachmentUploadResult>;
}

export interface ProjectsArea {
  attachments: ProjectAttachmentsArea;
  branches(args: ProjectBranchesArgs): Promise<ProjectBranchesResult>;
  commands(args: ProjectCommandsArgs): Promise<ProjectCommandsResult>;
  create(args: ProjectCreateArgs): Promise<ProjectCreateResult>;
  defaultExecutionOptions(
    args: ProjectDefaultExecutionOptionsArgs,
  ): Promise<ProjectDefaultExecutionOptionsResult>;
  delete(args: ProjectDeleteArgs): Promise<ProjectDeleteResult>;
  fileContent(args: ProjectFileContentArgs): Promise<ProjectFileContentResult>;
  files(args: ProjectFilesArgs): Promise<ProjectFilesResult>;
  get(args: ProjectGetArgs): Promise<ProjectGetResult>;
  list(args?: ProjectListArgs): Promise<ProjectListResult>;
  paths(args: ProjectPathsArgs): Promise<ProjectPathsResult>;
  promptHistory(
    args: ProjectPromptHistoryArgs,
  ): Promise<ProjectPromptHistoryResult>;
  reorder(args: ProjectReorderArgs): Promise<ProjectReorderResult>;
  sidebarBootstrap(
    args?: ProjectSidebarBootstrapArgs,
  ): Promise<ProjectSidebarBootstrapResult>;
  sources: ProjectSourcesArea;
  update(args: ProjectUpdateArgs): Promise<ProjectUpdateResult>;
}

function projectUpdateJson(args: ProjectUpdateArgs): UpdateProjectRequest {
  return {
    name: args.name,
  };
}

function projectSourceAddJson(
  args: ProjectSourceAddArgs,
): CreateProjectSourceRequest {
  if (args.type === "local_path") {
    return { hostId: args.hostId, path: args.path, type: args.type };
  }
  return {
    hostId: args.hostId,
    type: args.type,
    ...(args.remoteUrl !== undefined ? { remoteUrl: args.remoteUrl } : {}),
    ...(args.targetPath !== undefined ? { targetPath: args.targetPath } : {}),
  };
}

function projectSourceUpdateJson(
  args: ProjectSourceUpdateArgs,
): UpdateProjectSourceRequest {
  return {
    isDefault: args.isDefault,
    path: args.path,
    type: args.type,
  };
}

function embeddedAttachmentFilename(
  clientFile: ProjectAttachmentUploadFile,
): string | undefined {
  if ("name" in clientFile && typeof clientFile.name === "string") {
    return clientFile.name;
  }
  return undefined;
}

function projectListQuery(input: ProjectListArgs): ProjectListQuery {
  return {
    ...(input.include === undefined ? {} : { include: input.include }),
    ...(input.includePersonal === undefined
      ? {}
      : { includePersonal: input.includePersonal ? "true" : "false" }),
  };
}

function embeddedAttachmentMimeType(
  clientFile: ProjectAttachmentUploadFile,
): string | undefined {
  if ("type" in clientFile && typeof clientFile.type === "string") {
    return clientFile.type;
  }
  return undefined;
}

function hasAttachmentArrayBuffer(
  clientFile: ProjectAttachmentUploadFile,
): clientFile is Blob | ProjectAttachmentFileLike {
  return "arrayBuffer" in clientFile;
}

async function attachmentBytes(
  clientFile: ProjectAttachmentUploadFile,
): Promise<ArrayBuffer> {
  if (hasAttachmentArrayBuffer(clientFile)) {
    return clientFile.arrayBuffer();
  }
  if (ArrayBuffer.isView(clientFile)) {
    return Uint8Array.from(clientFile).buffer;
  }
  return clientFile.slice(0);
}

function resolveAttachmentFilename(input: ProjectAttachmentUploadArgs): string {
  const filename =
    input.filename ?? embeddedAttachmentFilename(input.clientFile);
  if (!filename || filename.trim().length === 0) {
    throw new Error("Project attachment filename must not be empty");
  }
  return filename;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block =
      (first << 16) | ((second ?? 0) << 8) | (third === undefined ? 0 : third);
    encoded += BASE64_ALPHABET.charAt((block >> 18) & 63);
    encoded += BASE64_ALPHABET.charAt((block >> 12) & 63);
    encoded +=
      second === undefined ? "=" : BASE64_ALPHABET.charAt((block >> 6) & 63);
    encoded += third === undefined ? "=" : BASE64_ALPHABET.charAt(block & 63);
  }
  return encoded;
}

export function createProjectsArea(args: CreateSdkAreaArgs): ProjectsArea {
  const { transport } = args;
  const attachments: ProjectAttachmentsArea = {
    async copy(input) {
      const { projectId, ...json } = input;
      await transport.readVoid(
        transport.api.v1.projects[":id"].attachments.copy.$post({
          param: { id: projectId },
          json,
        }),
      );
    },
    async read(input) {
      const response = await transport.resolve(
        transport.api.v1.projects[":id"].attachments.content.$get(
          {
            param: { id: input.projectId },
            query: { path: input.path },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        mimeType:
          response.headers.get("content-type") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      };
    },
    async upload(input) {
      const filename = resolveAttachmentFilename(input);
      const mimeType =
        input.mimeType ?? embeddedAttachmentMimeType(input.clientFile) ?? "";
      const file =
        input.clientFile instanceof Blob && input.clientFile.type === mimeType
          ? input.clientFile
          : new Blob([await attachmentBytes(input.clientFile)], {
              type: mimeType,
            });
      const form = new FormData();
      form.set("file", file, filename);
      const baseUrl = transport.baseUrl.replace(/\/$/u, "");
      const response = await transport.resolve(
        transport.fetch(
          `${baseUrl}/api/v1/projects/${encodeURIComponent(input.projectId)}/attachments`,
          {
            body: form,
            method: "POST",
          },
        ),
      );
      return uploadedPromptAttachmentSchema.parse(await response.json());
    },
  };
  const sources: ProjectSourcesArea = {
    async add(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].sources.$post({
          param: { id: input.projectId },
          json: projectSourceAddJson(input),
        }),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.projects[":id"].sources[":sourceId"].$delete({
          param: { id: input.projectId, sourceId: input.sourceId },
        }),
      );
      return { ok: true };
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].sources[":sourceId"].$patch({
          param: { id: input.projectId, sourceId: input.sourceId },
          json: projectSourceUpdateJson(input),
        }),
      );
    },
  };

  return {
    attachments,
    async branches(input) {
      const { projectId, signal, ...query } = input;
      return transport.readJson(
        transport.api.v1.projects[":id"].branches.$get(
          {
            param: { id: projectId },
            query,
          },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async commands(input) {
      const { projectId, signal, ...query } = input;
      return transport.readJson(
        transport.api.v1.projects[":id"].commands.$get(
          {
            param: { id: projectId },
            query,
          },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async create(input) {
      return transport.readJson(
        transport.api.v1.projects.$post({
          json: input,
        }),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.projects[":id"].$delete({
          param: { id: input.projectId },
        }),
      );
      return { ok: true };
    },
    async defaultExecutionOptions(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"]["default-execution-options"].$get(
          {
            param: { id: input.projectId },
            query: {},
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async fileContent(input) {
      const { projectId, signal, ...query } = input;
      const response = await transport.resolve(
        transport.api.v1.projects[":id"].files.content.$get(
          {
            param: { id: projectId },
            query,
          },
          ...signalRequestArgs(signal),
        ),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentEncoding = response.headers.get("x-bb-content-encoding");
      if (contentEncoding !== "utf8" && contentEncoding !== "base64") {
        throw new Error(
          "Project file response is missing its content encoding",
        );
      }
      return {
        content:
          contentEncoding === "utf8"
            ? new TextDecoder().decode(bytes)
            : encodeBase64(bytes),
        contentEncoding,
        mimeType:
          response.headers.get("content-type") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      };
    },
    async files(input) {
      const { projectId, signal, ...query } = input;
      return transport.readJson(
        transport.api.v1.projects[":id"].files.$get(
          {
            param: { id: projectId },
            query,
          },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async get(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].$get(
          {
            param: { id: input.projectId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input = {}) {
      const { signal, ...query } = input;
      return transport.readJson(
        transport.api.v1.projects.$get(
          {
            query: projectListQuery(query),
          },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async paths(input) {
      const { projectId, signal, ...query } = input;
      return transport.readJson(
        transport.api.v1.projects[":id"].paths.$get(
          {
            param: { id: projectId },
            query,
          },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async promptHistory(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"]["prompt-history"].$get(
          {
            param: { id: input.projectId },
            query: { limit: input.limit },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async reorder(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].order.$patch({
          param: { id: input.projectId },
          json: {
            previousProjectId: input.previousProjectId,
            nextProjectId: input.nextProjectId,
          },
        }),
      );
    },
    async sidebarBootstrap(input = {}) {
      return transport.readJson(
        transport.api.v1["sidebar-bootstrap"].$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    sources,
    async update(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].$patch({
          param: { id: input.projectId },
          json: projectUpdateJson(input),
        }),
      );
    },
  };
}
