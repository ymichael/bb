import type {
  CreateFilePreviewResponse,
  HostFileListResponse,
  HostFileReadResponse,
  HostFileWriteResponse,
  HostMkdirResponse,
  HostMovePathResponse,
  HostPathListResponse,
  HostRemovePathResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface FileReadArgs {
  hostId?: string;
  path: string;
  rootPath?: string;
  signal?: AbortSignal;
}

export interface FileWriteArgs {
  hostId?: string;
  path: string;
  rootPath?: string;
  content: string;
  contentEncoding?: "utf8" | "base64";
  createParents?: boolean;
  expectedSha256?: string | null;
  mode?: number;
}

export interface FileListArgs {
  hostId?: string;
  path: string;
  query?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface PathListArgs extends FileListArgs {
  includeFiles: boolean;
  includeDirectories: boolean;
}

export interface FileMkdirArgs {
  hostId?: string;
  path: string;
  rootPath?: string;
  recursive?: boolean;
}

export interface FileMoveArgs {
  hostId?: string;
  sourcePath: string;
  destinationPath: string;
  rootPath?: string;
}

export interface FileRemoveArgs {
  hostId?: string;
  path: string;
  rootPath?: string;
  recursive?: boolean;
}

export interface FilePreviewArgs {
  hostId?: string;
  rootPath: string;
  signal?: AbortSignal;
  ttlMs?: number;
}

export type FileReadResult = HostFileReadResponse;
export type FileWriteResult = HostFileWriteResponse;
export type FileListResult = HostFileListResponse;
export type PathListResult = HostPathListResponse;
export type FileMkdirResult = HostMkdirResponse;
export type FileMoveResult = HostMovePathResponse;
export type FileRemoveResult = HostRemovePathResponse;
export type FilePreviewResult = CreateFilePreviewResponse;

export interface FilesArea {
  read(args: FileReadArgs): Promise<FileReadResult>;
  write(args: FileWriteArgs): Promise<FileWriteResult>;
  list(args: FileListArgs): Promise<FileListResult>;
  listPaths(args: PathListArgs): Promise<PathListResult>;
  mkdir(args: FileMkdirArgs): Promise<FileMkdirResult>;
  move(args: FileMoveArgs): Promise<FileMoveResult>;
  remove(args: FileRemoveArgs): Promise<FileRemoveResult>;
  createPreview(args: FilePreviewArgs): Promise<FilePreviewResult>;
}

export function createFilesArea(args: CreateSdkAreaArgs): FilesArea {
  const { transport } = args;
  return {
    async read(input) {
      return transport.readJson(
        transport.api.v1.files.read.$post(
          {
            json: {
              hostId: input.hostId,
              path: input.path,
              rootPath: input.rootPath,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async write(input) {
      return transport.readJson(
        transport.api.v1.files.write.$post({ json: input }),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.files.list.$post(
          {
            json: {
              hostId: input.hostId,
              limit: input.limit,
              path: input.path,
              query: input.query,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async listPaths(input) {
      return transport.readJson(
        transport.api.v1.files.paths.$post(
          {
            json: {
              hostId: input.hostId,
              includeDirectories: input.includeDirectories,
              includeFiles: input.includeFiles,
              limit: input.limit,
              path: input.path,
              query: input.query,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async mkdir(input) {
      return transport.readJson(
        transport.api.v1.files.mkdir.$post({ json: input }),
      );
    },
    async move(input) {
      return transport.readJson(
        transport.api.v1.files.move.$post({ json: input }),
      );
    },
    async remove(input) {
      return transport.readJson(
        transport.api.v1.files.remove.$post({ json: input }),
      );
    },
    async createPreview(input) {
      return transport.readJson(
        transport.api.v1.files.previews.$post(
          {
            json: {
              hostId: input.hostId,
              rootPath: input.rootPath,
              ttlMs: input.ttlMs,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
