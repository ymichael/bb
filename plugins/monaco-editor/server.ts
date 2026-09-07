import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

const MAX_TREE_ENTRIES = 10_000;

const ASSET_LEASE_TTL_MS = 60 * 60 * 1000;

const ASSET_LEASE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();

const fileSchema = z
  .object({ path: z.string().min(1), source: sourceSchema })
  .strict();

export const rpcContract = defineRpcContract({
  assets: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
  },
  read: {
    input: fileSchema,
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sha256: z.string(),
        absolutePath: z.string(),
        relativePath: z.string(),
      }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  },
  tree: {
    input: z.object({ source: sourceSchema }).strict(),
    output: z.object({
      root: z.string(),
      entries: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["file", "directory"]),
        }),
      ),
      truncated: z.boolean(),
    }),
  },
  write: {
    input: fileSchema.extend({
      content: z.string(),
      expectedSha256: z.string().nullable(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
});

function isBundleStale(moduleDir: string, bundleDir: string): boolean {
  const builtAtMs = statSync(path.join(bundleDir, "editor.js")).mtimeMs;
  const entryDir = path.join(moduleDir, "monaco-bundle");
  if (!existsSync(entryDir)) return false;

  const inputs = [
    path.join(moduleDir, "scripts", "stage-assets.mjs"),
    ...readdirSync(entryDir).map((name) => path.join(entryDir, name)),
    path.join(moduleDir, "package.json"),
  ];
  return inputs.some(
    (input) => existsSync(input) && statSync(input).mtimeMs > builtAtMs,
  );
}

async function ensureMonacoBundleDir(
  log: (message: string) => void,
): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "monaco"),
    path.join(moduleDir, "dist", "monaco"),
  ];
  const built = candidates.find((candidate) =>
    existsSync(path.join(candidate, "editor.js")),
  );
  if (built !== undefined && !isBundleStale(moduleDir, built)) return built;

  log(
    built === undefined
      ? "Monaco bundle missing; building it (first run in a source checkout)"
      : "Monaco bundle is older than its sources; rebuilding it",
  );
  const script = new URL("./scripts/stage-assets.mjs", import.meta.url).href;
  await import(script);

  const staged = candidates.find((candidate) =>
    existsSync(path.join(candidate, "editor.js")),
  );
  if (staged === undefined) {
    throw new Error(
      "could not build the Monaco bundle; run `pnpm --filter bb-plugin-monaco-editor build:monaco`",
    );
  }
  return staged;
}

export default async function plugin(bb: BbPluginApi) {
  let assetLease: { baseUrl: string; expiresAtMs: number } | null = null;

  async function assets() {
    const now = Date.now();
    if (
      assetLease === null ||
      assetLease.expiresAtMs - now < ASSET_LEASE_REFRESH_MARGIN_MS
    ) {
      const bundleDir = await ensureMonacoBundleDir((message) =>
        bb.log.info(message),
      );
      assetLease = await bb.sdk.files.createPreview({
        rootPath: bundleDir,
        ttlMs: ASSET_LEASE_TTL_MS,
      });
    }
    return assetLease;
  }

  async function threadStorageRoot(): Promise<string> {
    const override = process.env.BB_THREAD_STORAGE;
    if (override && override.trim().length > 0) return path.resolve(override);
    const { dataDir } = await bb.sdk.system.config();
    return path.join(dataDir, "thread-storage");
  }

  async function resolveTarget(
    source: z.infer<typeof sourceSchema>,
    filePath: string,
  ): Promise<{ path: string; rootPath: string; hostId?: string }> {
    if (source.kind === "thread-storage") {
      if (source.threadId === null) {
        throw new Error("This thread-storage file has no thread");
      }
      const rootPath = path.join(await threadStorageRoot(), source.threadId);
      return { path: path.join(rootPath, filePath), rootPath };
    }
    if (source.environmentId === null && source.kind === "workspace") {
      if (source.projectId === null) {
        throw new Error("This file has no environment or project");
      }
      const project = await bb.sdk.projects.get({
        projectId: source.projectId,
      });
      const sources = project.sources;
      const checkout =
        source.experimental_hostId === undefined
          ? (sources.find((entry) => entry.isDefault) ?? sources[0])
          : sources.find(
              (entry) => entry.hostId === source.experimental_hostId,
            );
      if (checkout === undefined) {
        throw new Error("This project has no matching source checkout");
      }
      return {
        path: path.join(checkout.path, filePath),
        rootPath: checkout.path,
        hostId: checkout.hostId,
      };
    }
    if (source.environmentId === null) {
      throw new Error("This file has no environment to resolve it against");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });

    if (source.kind === "host") {
      const api = path.win32.isAbsolute(filePath) ? path.win32 : path.posix;
      return {
        path: filePath,
        rootPath: api.dirname(filePath),
        ...(environment.hostId ? { hostId: environment.hostId } : {}),
      };
    }

    if (!environment.path) {
      throw new Error("This environment has no workspace path");
    }
    return {
      path: path.join(environment.path, filePath),
      rootPath: environment.path,
      ...(environment.hostId ? { hostId: environment.hostId } : {}),
    };
  }

  function relativeTo(root: string, target: string): string {
    const api = path.win32.isAbsolute(root) ? path.win32 : path.posix;
    return api.relative(root, target) || api.basename(target);
  }

  bb.rpc.register(rpcContract, {
    assets: () => assets(),

    async read({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      const file = await bb.sdk.files.read(target);

      if (file.contentEncoding !== "utf8") {
        return {
          kind: "unsupported" as const,
          reason: "This file is not text",
        };
      }
      if (file.sizeBytes > MAX_EDITABLE_BYTES) {
        return {
          kind: "unsupported" as const,
          reason: `This file is too large to edit (${Math.round(file.sizeBytes / 1024 / 1024)} MB)`,
        };
      }
      return {
        kind: "text" as const,
        content: file.content,
        sha256: file.sha256,
        absolutePath: target.path,
        relativePath: relativeTo(target.rootPath, target.path),
      };
    },

    async tree({ source }) {
      const target = await resolveTarget(source, ".");
      const result = await bb.sdk.files.listPaths({
        path: target.rootPath,
        includeFiles: true,
        includeDirectories: true,
        limit: MAX_TREE_ENTRIES,
        ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
      });
      return {
        root: target.rootPath,
        entries: result.paths.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
        })),
        truncated: result.truncated,
      };
    },

    async write({ path: filePath, source, content, expectedSha256 }) {
      const target = await resolveTarget(source, filePath);
      const result = await bb.sdk.files.write({
        ...target,
        content,
        contentEncoding: "utf8",
        expectedSha256,
      });
      return result.outcome === "written"
        ? { outcome: "written" as const, sha256: result.sha256 }
        : { outcome: "conflict" as const, currentSha256: result.currentSha256 };
    },
  });
}
