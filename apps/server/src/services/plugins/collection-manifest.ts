import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PluginSourceSelection } from "@bb/server-contract";
import {
  normalizePluginSubdirectory,
  realPathInside,
} from "./install-sources.js";
import { readPluginManifest } from "./manifest.js";

const COLLECTION_MANIFEST_PATH = ".bb/plugins.json";
export const COLLECTION_SCHEMA_URL =
  "https://getbb.app/schemas/plugins.schema.json";

const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function subdirectoryFromCollectionSource(source: string): string {
  if (!source.startsWith("./")) {
    throw new Error(`source "${source}" must start with "./"`);
  }
  return normalizePluginSubdirectory(source);
}

const collectionEntrySchema = z
  .object({
    name: z.string().regex(COLLECTION_NAME_PATTERN),
    source: z.string(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    try {
      subdirectoryFromCollectionSource(entry.source);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const pluginCollectionManifestSchema = z
  .object({
    $schema: z.literal(COLLECTION_SCHEMA_URL).optional(),
    schemaVersion: z.literal(1),
    name: z.string().regex(COLLECTION_NAME_PATTERN),
    plugins: z.array(collectionEntrySchema).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.plugins.forEach((entry, index) => {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", index, "name"],
          message: `duplicate plugin name "${entry.name}"`,
        });
      }
      seen.add(entry.name);
    });
  });

type PluginCollectionManifest = z.infer<typeof pluginCollectionManifestSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parsePluginCollectionManifest(
  raw: string,
  location: string,
): PluginCollectionManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid ${location}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = pluginCollectionManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`invalid ${location}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export async function readPluginCollectionManifest(
  checkoutDir: string,
): Promise<PluginCollectionManifest | null> {
  let realPath: string;
  try {
    realPath = await realPathInside(
      checkoutDir,
      join(checkoutDir, ".bb", "plugins.json"),
      COLLECTION_MANIFEST_PATH,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
  return parsePluginCollectionManifest(
    await readFile(realPath, "utf8"),
    COLLECTION_MANIFEST_PATH,
  );
}

export function subdirectoryForCollectionEntry(
  manifest: PluginCollectionManifest,
  name: string,
): string {
  const entry = manifest.plugins.find((plugin) => plugin.name === name);
  if (entry === undefined) {
    throw new Error(
      `${COLLECTION_MANIFEST_PATH} has no plugin "${name}" — available: ${manifest.plugins
        .map((plugin) => plugin.name)
        .join(", ")}`,
    );
  }
  return subdirectoryFromCollectionSource(entry.source);
}

export async function resolveSelectedSubdirectory(args: {
  checkoutDir: string;
  selection: PluginSourceSelection;
  sourceLabel: string;
}): Promise<string | null> {
  if (args.selection.kind === "subdirectory") {
    return normalizePluginSubdirectory(args.selection.path);
  }
  const manifest = await readPluginCollectionManifest(args.checkoutDir);
  if (args.selection.kind === "entry") {
    if (manifest === null) {
      throw new Error(
        `${args.sourceLabel} has no ${COLLECTION_MANIFEST_PATH} collection manifest — install it with --subdirectory instead`,
      );
    }
    return subdirectoryForCollectionEntry(manifest, args.selection.name);
  }
  if (manifest === null) return null;
  const rootIsPlugin = await readPluginManifest(args.checkoutDir)
    .then(() => true)
    .catch(() => false);
  if (rootIsPlugin) return null;
  throw new Error(
    `${args.sourceLabel} contains several plugins — select one with --plugin <name> (${manifest.plugins
      .map((plugin) => plugin.name)
      .join(", ")}) or --subdirectory <path>`,
  );
}
