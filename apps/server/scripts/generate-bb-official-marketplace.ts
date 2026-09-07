import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  derivePluginId,
  isPluginOwnedIconPath,
  MARKETPLACE_OVERVIEW_MAX_CHARS,
  PLUGIN_CATALOG_CATEGORIES,
  pluginCatalogCategoryIdSchema,
  pluginPackageJsonSchema,
} from "@bb/domain";
import { z } from "zod";
import {
  BUNDLED_MARKETPLACE_FILENAME,
  BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
  BUNDLED_MARKETPLACE_NAME,
} from "../src/services/plugin-catalog/bundled-marketplace-paths.js";
import { BUNDLED_PLUGINS } from "../src/services/plugins/builtin-registry.js";

const run = promisify(execFile);

const categoryIds: ReadonlySet<string> = new Set(
  PLUGIN_CATALOG_CATEGORIES.map((category) => category.id),
);

const screenshotSchema = z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "getbb.app") {
      ctx.addIssue({
        code: "custom",
        message: "must be an https URL on getbb.app",
      });
    }
    if (!/\.(?:jpe?g|png|webp)$/iu.test(url.pathname)) {
      ctx.addIssue({
        code: "custom",
        message: "must use a jpg, jpeg, png, or webp file",
      });
    }
  } catch {
    ctx.addIssue({ code: "custom", message: "must be a valid URL" });
  }
});

const catalogBlockSchema = z
  .object({
    category: pluginCatalogCategoryIdSchema.refine(
      (category) => categoryIds.has(category),
      "must be a built-in category id",
    ),
    screenshots: z.array(screenshotSchema).max(6),
  })
  .strict();

const catalogFieldsSchema = z.record(z.string(), catalogBlockSchema);

export interface BundledPluginIdentity {
  name: string;
  pluginId: string;
}

export interface PluginGitDates {
  publishedAt: string;
  updatedAt: string;
}

export function parseBbOfficialCatalogFields(
  input: unknown,
  plugins: readonly BundledPluginIdentity[],
): Record<string, z.infer<typeof catalogBlockSchema>> {
  const fields = catalogFieldsSchema.parse(input);
  const expected = new Set(plugins.map((plugin) => plugin.name));
  const missing = plugins
    .map((plugin) => plugin.name)
    .filter((name) => fields[name] === undefined);
  const extra = Object.keys(fields).filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    const problems = [
      ...(missing.length === 0
        ? []
        : [`missing bundled plugin blocks: ${missing.join(", ")}`]),
      ...(extra.length === 0
        ? []
        : [`unknown bundled plugin blocks: ${extra.join(", ")}`]),
    ];
    throw new Error(
      `invalid bb-official catalog fields: ${problems.join("; ")}`,
    );
  }
  return fields;
}

export async function readPluginGitDates(args: {
  repositoryRoot: string;
  plugins: readonly BundledPluginIdentity[];
  warn: (message: string) => void;
}): Promise<ReadonlyMap<string, PluginGitDates>> {
  try {
    const state = await run(
      "git",
      ["rev-parse", "--is-inside-work-tree", "--is-shallow-repository"],
      { cwd: args.repositoryRoot },
    );
    const [inside, shallow] = state.stdout.trim().split(/\s+/u);
    if (inside !== "true" || shallow === "true") {
      args.warn(
        "bb-official marketplace dates were omitted because complete Git history is unavailable",
      );
      return new Map();
    }
  } catch {
    args.warn(
      "bb-official marketplace dates were omitted because complete Git history is unavailable",
    );
    return new Map();
  }

  let historyText: string;
  try {
    const history = await run(
      "git",
      [
        "log",
        "--format=%x1e%cI",
        "--name-only",
        "--",
        ...args.plugins.map((plugin) => `plugins/${plugin.name}/`),
      ],
      { cwd: args.repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    historyText = history.stdout.toString();
  } catch {
    args.warn(
      "bb-official marketplace dates were omitted because complete Git history is unavailable",
    );
    return new Map();
  }
  const dates = new Map<string, PluginGitDates>();
  for (const commit of historyText.split("\x1e").slice(1)) {
    const [date, ...files] = commit
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (date === undefined) continue;
    for (const plugin of args.plugins) {
      if (!files.some((file) => file.startsWith(`plugins/${plugin.name}/`))) {
        continue;
      }
      const current = dates.get(plugin.name);
      dates.set(plugin.name, {
        publishedAt: date,
        updatedAt: current?.updatedAt ?? date,
      });
    }
  }
  return dates;
}

const OVERVIEW_HTML_OR_IMAGE_PATTERN = /<[A-Za-z!/?]|!\[/u;

export function normalizeBundledOverviewText(text: string): string {
  return `${text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "")}\n`;
}

export async function readBundledPluginOverview(
  pluginDirectory: string,
  pluginName: string,
): Promise<string | undefined> {
  const overviewPath = path.join(pluginDirectory, "PLUGIN_OVERVIEW.md");
  if (!existsSync(overviewPath)) return undefined;
  const overview = normalizeBundledOverviewText(
    await readFile(overviewPath, "utf8"),
  );
  const length = [...overview.replace(/\n$/u, "")].length;
  if (length === 0) {
    throw new Error(
      `bundled plugin ${pluginName} has an empty PLUGIN_OVERVIEW.md`,
    );
  }
  if (length > MARKETPLACE_OVERVIEW_MAX_CHARS) {
    throw new Error(
      `bundled plugin ${pluginName} PLUGIN_OVERVIEW.md has ${length} characters; the maximum is ${MARKETPLACE_OVERVIEW_MAX_CHARS}`,
    );
  }
  const prose = overview
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`/gu, "");
  if (OVERVIEW_HTML_OR_IMAGE_PATTERN.test(prose)) {
    throw new Error(
      `bundled plugin ${pluginName} PLUGIN_OVERVIEW.md must not hold raw HTML or an image`,
    );
  }
  return overview;
}

function marketplaceIcon(pluginName: string, declared: string) {
  if (!isPluginOwnedIconPath(declared)) return declared;
  const relative = declared.replace(/^\.\//u, "");
  return { url: `./${pluginName}/${relative}` };
}

export async function generateBbOfficialMarketplace(args: {
  repositoryRoot: string;
  catalogFieldsPath: string;
  outputPath: string;
  plugins: readonly BundledPluginIdentity[];
  warn: (message: string) => void;
}): Promise<void> {
  const catalogJson: unknown = JSON.parse(
    await readFile(args.catalogFieldsPath, "utf8"),
  );
  const fields = parseBbOfficialCatalogFields(catalogJson, args.plugins);
  const dates = await readPluginGitDates({
    repositoryRoot: args.repositoryRoot,
    plugins: args.plugins,
    warn: args.warn,
  });
  const entries = await Promise.all(
    args.plugins.map(async (plugin) => {
      const pluginDirectory = path.join(
        args.repositoryRoot,
        "plugins",
        plugin.name,
      );
      const packageJson: unknown = JSON.parse(
        await readFile(path.join(pluginDirectory, "package.json"), "utf8"),
      );
      const overview = await readBundledPluginOverview(
        pluginDirectory,
        plugin.name,
      );
      const manifest = pluginPackageJsonSchema.parse(packageJson);
      const id = derivePluginId(manifest.name);
      if (id !== plugin.pluginId) {
        throw new Error(
          `bundled plugin ${plugin.name} has registry id ${plugin.pluginId}, but its manifest produces ${id}`,
        );
      }
      const declaredIcon = manifest.bb.branding.icon;
      if (declaredIcon === undefined) {
        throw new Error(`bundled plugin ${plugin.name} has no manifest icon`);
      }
      const catalog = fields[plugin.name];
      if (catalog === undefined) {
        throw new Error(`bundled plugin ${plugin.name} has no catalog block`);
      }
      const gitDates = dates.get(plugin.name);
      return {
        id,
        displayName: manifest.bb.name,
        description: manifest.bb.description,
        icon: marketplaceIcon(plugin.name, declaredIcon),
        tags: [],
        author: { name: "BB" },
        source: { bundled: { plugin: plugin.name } },
        category: catalog.category,
        screenshots: catalog.screenshots,
        ...(overview === undefined ? {} : { overview }),
        ...(gitDates === undefined ? {} : gitDates),
      };
    }),
  );
  const document = {
    schemaVersion: 2,
    name: BUNDLED_MARKETPLACE_NAME,
    displayName: "BB Official",
    description: "Plugins that ship with bb.",
    categories: PLUGIN_CATALOG_CATEGORIES,
    collections: [
      {
        id: "bb-official",
        displayName: "BB Official",
        pluginIds: entries.map((entry) => entry.id),
      },
    ],
    plugins: entries,
  };
  await mkdir(path.dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, `${JSON.stringify(document, null, 2)}\n`);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const outputPath = path.join(
  repositoryRoot,
  "apps",
  "server",
  "src",
  "generated",
  BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
  BUNDLED_MARKETPLACE_FILENAME,
);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await generateBbOfficialMarketplace({
    repositoryRoot,
    catalogFieldsPath: path.join(repositoryRoot, "plugins", "bb-official.json"),
    outputPath,
    plugins: BUNDLED_PLUGINS,
    warn: (message) => process.stderr.write(`warning: ${message}\n`),
  });
}
