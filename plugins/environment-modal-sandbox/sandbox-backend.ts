import { ModalClient, NotFoundError, type Sandbox } from "modal";

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  exec(
    command: readonly string[],
    options: { timeoutMs: number },
  ): Promise<SandboxExecResult>;
  terminate(): Promise<void>;
  poll(): Promise<number | null>;
  snapshotFilesystem(options: {
    timeoutMs: number;
    ttlMs: number | null;
  }): Promise<string>;
}

export type SandboxImage =
  | { type: "registry"; reference: string }
  | { type: "snapshot"; imageId: string };

export interface SandboxCreateRequest {
  appName: string;
  name: string;
  image: SandboxImage;
  environmentVariables: Readonly<Record<string, string>>;
  timeoutMs: number;
  cpu: number | null;
  memoryMiB: number | null;
  tags: Record<string, string>;
}

export interface SandboxBackend {
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
  deleteSnapshot(imageId: string): Promise<void>;
  fromId(sandboxId: string): Promise<SandboxHandle | null>;
  fromName(appName: string, name: string): Promise<SandboxHandle | null>;
}

export interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
}

export type SandboxBackendFactory = (
  credentials: ModalCredentials,
) => SandboxBackend;

function wrapSandbox(sandbox: Sandbox): SandboxHandle {
  return {
    sandboxId: sandbox.sandboxId,
    async exec(command, options) {
      const process = await sandbox.exec([...command], {
        mode: "text",
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: options.timeoutMs,
      });
      const [stdout, stderr] = await Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
      ]);
      const exitCode = await process.wait();
      return { exitCode, stdout, stderr };
    },
    async terminate() {
      await sandbox.terminate();
    },
    poll() {
      return sandbox.poll();
    },
    async snapshotFilesystem(options) {
      const image = await sandbox.snapshotFilesystem(options);
      return image.imageId;
    },
  };
}

export const createModalBackend: SandboxBackendFactory = (credentials) => {
  const client = new ModalClient({
    tokenId: credentials.tokenId,
    tokenSecret: credentials.tokenSecret,
  });
  return {
    async create(request) {
      const app = await client.apps.fromName(request.appName, {
        createIfMissing: true,
      });
      const image =
        request.image.type === "registry"
          ? client.images.fromRegistry(request.image.reference)
          : await client.images.fromId(request.image.imageId);
      const sandbox = await client.sandboxes.create(app, image, {
        name: request.name,
        timeoutMs: request.timeoutMs,
        tags: request.tags,
        env: { ...request.environmentVariables },
        ...(request.cpu === null ? {} : { cpu: request.cpu }),
        ...(request.memoryMiB === null ? {} : { memoryMiB: request.memoryMiB }),
      });
      return wrapSandbox(sandbox);
    },
    async deleteSnapshot(imageId) {
      try {
        await client.images.delete(imageId);
      } catch (error) {
        if (error instanceof NotFoundError) return;
        throw error;
      }
    },
    async fromId(sandboxId) {
      try {
        return wrapSandbox(await client.sandboxes.fromId(sandboxId));
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    async fromName(appName, name) {
      try {
        return wrapSandbox(await client.sandboxes.fromName(appName, name));
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  };
};
