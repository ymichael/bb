import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const SERVER_TARGET_FILE_NAME = "server-target.json";
export const BUILTIN_SERVER_NAME = "This Mac";

export interface ConnectServerRef {
  handle: string;
  name: string;
  url: string;
}

type DesktopServerTarget =
  | { kind: "builtin" }
  | { kind: "connect"; server: ConnectServerRef }
  | { kind: "custom"; url: string };

export interface ServerTargetFs {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

interface CreateServerTargetStoreArgs {
  fs?: ServerTargetFs;
  storagePath: string;
}

export interface ServerTargetStore {
  getConnectServer(): ConnectServerRef | null;
  getCustomServerUrl(): string | null;
  getTarget(): DesktopServerTarget;
  load(): Promise<void>;
  refreshConnectServer(server: ConnectServerRef): Promise<boolean>;
  setConnectServer(server: ConnectServerRef): Promise<void>;
  setCustomServerUrl(url: string | null): Promise<void>;
  setTarget(kind: "builtin" | "connect" | "custom"): Promise<boolean>;
}

const persistedConnectServerSchema = z
  .object({
    handle: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

const persistedServerTargetSchema = z
  .object({
    connectServer: persistedConnectServerSchema.nullable().optional(),
    customServerUrl: z.string().min(1).nullable(),
    target: z.enum(["builtin", "connect", "custom"]),
  })
  .strict();

type PersistedServerTarget = z.infer<typeof persistedServerTargetSchema>;

const defaultFs: ServerTargetFs = {
  mkdir,
  readFile,
  writeFile,
};

export function normalizeCustomServerUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function parsePersistedServerTarget(raw: string): PersistedServerTarget | null {
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = persistedServerTargetSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createServerTargetStore(
  args: CreateServerTargetStoreArgs,
): ServerTargetStore {
  const fsImpl = args.fs ?? defaultFs;
  let connectServer: ConnectServerRef | null = null;
  let customServerUrl: string | null = null;
  let target: "builtin" | "connect" | "custom" = "builtin";

  async function persist(): Promise<void> {
    await fsImpl.mkdir(dirname(args.storagePath), { recursive: true });
    const payload: PersistedServerTarget = {
      connectServer,
      customServerUrl,
      target,
    };
    await fsImpl.writeFile(
      args.storagePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    getConnectServer() {
      return connectServer === null ? null : { ...connectServer };
    },
    getCustomServerUrl() {
      return customServerUrl;
    },
    getTarget() {
      if (target === "custom" && customServerUrl !== null) {
        return { kind: "custom", url: customServerUrl };
      }
      if (target === "connect" && connectServer !== null) {
        return { kind: "connect", server: { ...connectServer } };
      }
      return { kind: "builtin" };
    },
    async load() {
      let persisted: PersistedServerTarget | null = null;
      try {
        persisted = parsePersistedServerTarget(
          await fsImpl.readFile(args.storagePath, "utf8"),
        );
      } catch {
        persisted = null;
      }
      if (persisted === null) {
        connectServer = null;
        customServerUrl = null;
        target = "builtin";
        return;
      }
      connectServer = persisted.connectServer ?? null;
      customServerUrl =
        persisted.customServerUrl === null
          ? null
          : normalizeCustomServerUrl(persisted.customServerUrl);
      if (persisted.target === "custom" && customServerUrl !== null) {
        target = "custom";
      } else if (persisted.target === "connect" && connectServer !== null) {
        target = "connect";
      } else {
        target = "builtin";
      }
    },
    async refreshConnectServer(server) {
      if (
        connectServer === null ||
        connectServer.handle !== server.handle ||
        (connectServer.name === server.name && connectServer.url === server.url)
      ) {
        return false;
      }
      connectServer = { ...server };
      await persist();
      return true;
    },
    async setConnectServer(server) {
      connectServer = { ...server };
      target = "connect";
      await persist();
    },
    async setCustomServerUrl(url) {
      if (url === null) {
        customServerUrl = null;
        if (target === "custom") {
          target = "builtin";
        }
      } else {
        customServerUrl = url;
        target = "custom";
      }
      await persist();
    },
    async setTarget(kind) {
      if (kind === "custom" && customServerUrl === null) {
        return false;
      }
      if (kind === "connect" && connectServer === null) {
        return false;
      }
      if (target === kind) {
        return true;
      }
      target = kind;
      await persist();
      return true;
    },
  };
}
