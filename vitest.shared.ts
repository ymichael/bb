import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { mergeConfig, type ViteUserConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const GLOBAL_OBJECT = String.raw`(?:window|globalThis|global|document|navigator|[A-Z][\w$]*\.prototype)`;
const GLOBAL_TARGET = String.raw`(?:${GLOBAL_OBJECT}|\(\s*${GLOBAL_OBJECT}\s+as\b[^)]*\))`;

const ISOLATION_REQUIRING_API = new RegExp(
  [
    String.raw`\bvi\.(mock|doMock|unmock|doUnmock|resetModules|stubGlobal|stubEnv)\(`,
    String.raw`\bprocess\.chdir\(`,
    String.raw`\bprocess\.env(\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=[^=]`,
    String.raw`\bdelete\s+process\.env\b`,
    String.raw`\b${GLOBAL_TARGET}\.[A-Za-z_$][\w$.]*\s*=[^=]`,
    String.raw`\bdelete\s+${GLOBAL_TARGET}(?![\w$])`,
    String.raw`\b(?:Object\.(?:defineProperty|defineProperties|assign)|Reflect\.(?:set|defineProperty|deleteProperty))\(\s*${GLOBAL_TARGET}(?![\w$])`,
  ].join("|"),
);

const IMPORT_SPECIFIER =
  /\b(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".js",
  ".jsx",
];

const TEST_SUPPORT_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "fixtures",
  "testing",
  "test-utils",
]);
const TEST_SUPPORT_FILE =
  /(^|[.-])(test|tests|mock|mocks|harness|fixture|fixtures|helpers?)(\.|-|$)/;

function isTestSupportModule(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  const baseName = (segments.pop() ?? "").replace(/\.[cm]?[jt]sx?$/, "");
  return (
    segments.some((segment) => TEST_SUPPORT_DIRS.has(segment)) ||
    TEST_SUPPORT_FILE.test(baseName)
  );
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

const ENVIRONMENT_DOCBLOCK = /@(?:vitest|jest)-environment\s+([\w-]+)/;

const ISOLATED_ENVIRONMENTS = new Set(["jsdom", "happy-dom"]);

export interface PartitionOptions {
  aliases?: Record<string, string>;
  defaultEnvironment?: string;
}

export interface SharedTestFileGroup {
  environment: string | null;
  files: string[];
}

export interface TestFilePartition {
  shared: SharedTestFileGroup[];
  isolated: string[];
}

interface IsolationScan {
  pkgDir: string;
  aliases: Record<string, string>;
  memo: Map<string, boolean>;
  visiting: Set<string>;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveLocalImport(
  fromFile: string,
  specifier: string,
  scan: IsolationScan,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    for (const [alias, target] of Object.entries(scan.aliases)) {
      if (specifier === alias || specifier.startsWith(`${alias}/`)) {
        base = path.resolve(
          scan.pkgDir,
          target,
          specifier.slice(alias.length + 1),
        );
        break;
      }
    }
  }
  if (base === null) return null;
  const withoutJs = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => withoutJs + extension),
    ...SOURCE_EXTENSIONS.map((extension) =>
      path.join(base, `index${extension}`),
    ),
  ];
  for (const candidate of candidates) {
    const relative = path.relative(scan.pkgDir, candidate);
    if (
      relative.startsWith("..") ||
      relative.split(path.sep).includes("node_modules")
    ) {
      continue;
    }
    if (!isFile(candidate)) continue;
    return isTestSupportModule(relative) ? candidate : null;
  }
  return null;
}

function requiresIsolation(file: string, scan: IsolationScan): boolean {
  const memo = scan.memo.get(file);
  if (memo !== undefined) return memo;
  if (scan.visiting.has(file)) return false;
  scan.visiting.add(file);
  const source = readFileSync(file, "utf8");
  let result = ISOLATION_REQUIRING_API.test(source);
  if (!result) {
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      const target = resolveLocalImport(file, specifier, scan);
      if (target !== null && requiresIsolation(target, scan)) {
        result = true;
        break;
      }
    }
  }
  scan.visiting.delete(file);
  scan.memo.set(file, result);
  return result;
}

export function partitionTestFiles(
  pkgDir: string,
  roots: string[],
  options: PartitionOptions = {},
): TestFilePartition {
  const defaultEnvironment = options.defaultEnvironment ?? "node";
  const scan: IsolationScan = {
    pkgDir,
    aliases: options.aliases ?? {},
    memo: new Map(),
    visiting: new Set(),
  };
  const sharedByEnvironment = new Map<string | null, Set<string>>();
  const isolated = new Set<string>();
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else if (TEST_FILE.test(entry.name)) {
        const relative = path
          .relative(pkgDir, fullPath)
          .split(path.sep)
          .join("/");
        const source = readFileSync(fullPath, "utf8");
        const environment = ENVIRONMENT_DOCBLOCK.exec(source)?.[1] ?? null;
        if (
          ISOLATED_ENVIRONMENTS.has(environment ?? defaultEnvironment) ||
          requiresIsolation(fullPath, scan)
        ) {
          isolated.add(relative);
        } else {
          let group = sharedByEnvironment.get(environment);
          if (!group) {
            group = new Set();
            sharedByEnvironment.set(environment, group);
          }
          group.add(relative);
        }
      }
    }
  };
  for (const root of new Set(roots)) walk(path.join(pkgDir, root));
  const shared = [...sharedByEnvironment]
    .map(([environment, files]) => ({ environment, files: [...files].sort() }))
    .sort((a, b) => {
      if (a.environment === null) return -1;
      if (b.environment === null) return 1;
      return a.environment.localeCompare(b.environment);
    });
  return { shared, isolated: [...isolated].sort() };
}

type TestProjects = NonNullable<
  NonNullable<ViteUserConfig["test"]>["projects"]
>;

export interface SharedWorkerProjectsArgs {
  pkgDir: string;
  name: string;
  include: string[];
  exclude?: string[];
  aliases?: Record<string, string>;
  defaultEnvironment?: string;
}

export function sharedWorkerProjects(
  args: SharedWorkerProjectsArgs,
): TestProjects {
  const exclude = args.exclude ?? ["dist/**", "node_modules/**"];
  const options: PartitionOptions = {};
  if (args.aliases !== undefined) options.aliases = args.aliases;
  if (args.defaultEnvironment !== undefined) {
    options.defaultEnvironment = args.defaultEnvironment;
  }
  const partition = partitionTestFiles(
    args.pkgDir,
    args.include.map(globRoot),
    options,
  );
  const allFiles = [
    ...partition.shared.flatMap((group) => group.files),
    ...partition.isolated,
  ];
  if (allFiles.length === 0) {
    return [
      {
        extends: true,
        test: { name: args.name, include: args.include, exclude },
      },
    ];
  }
  const otherFiles = (own: readonly string[]) => {
    const ownSet = new Set(own);
    return allFiles.filter((file) => !ownSet.has(file));
  };
  const projects: TestProjects = partition.shared.map((group) => ({
    extends: true,
    test: {
      name:
        group.environment === null
          ? args.name
          : `${args.name}:${group.environment}`,
      include: args.include,
      exclude: [...exclude, ...otherFiles(group.files)],
      isolate: false,
    },
  }));
  if (partition.isolated.length > 0) {
    projects.push({
      extends: true,
      test: {
        name: `${args.name}:isolated`,
        include: args.include,
        exclude: [...exclude, ...otherFiles(partition.isolated)],
      },
    });
  }
  return projects;
}

export class SharedWorkerSequencer extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const rank = (spec: TestSpecification) =>
      spec.project.config.isolate ? 0 : 1;
    return sorted
      .map((spec, index) => ({ spec, index }))
      .sort(
        (a, b) =>
          rank(a.spec) - rank(b.spec) ||
          a.spec.project.name.localeCompare(b.spec.project.name) ||
          a.index - b.index,
      )
      .map(({ spec }) => spec);
  }
}

function globRoot(glob: string): string {
  const segments = glob.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?{}[\]]/.test(segment)) break;
    literal.push(segment);
  }
  if (literal.length === segments.length) literal.pop();
  return literal.length > 0 ? literal.join("/") : ".";
}

function hugeiconsBundleAlias(): { find: RegExp; replacement: string }[] {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const packageJson =
      require.resolve("@hugeicons/core-free-icons/package.json");
    return [
      {
        find: /^@hugeicons\/core-free-icons$/,
        replacement: path.join(
          path.dirname(packageJson),
          "dist",
          "esm",
          "index.min.js",
        ),
      },
    ];
  } catch {
    return [];
  }
}

export function defineWorkspaceTestConfig(
  config: ViteUserConfig,
): ViteUserConfig {
  return mergeConfig(
    {
      resolve: {
        alias: hugeiconsBundleAlias(),
        conditions: ["source"],
      },
      test: {
        sequence: { sequencer: SharedWorkerSequencer },
        coverage: {
          provider: "v8",
          include: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
          exclude: [
            "**/*.d.ts",
            "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
            "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
            "**/*.stories.{ts,tsx,js,jsx}",
            "**/*.gen.{ts,tsx,js,jsx}",
            "**/__fixtures__/**",
            "**/__tests__/**",
            "**/generated/**",
            ".turbo/**",
            "coverage/**",
            "dist/**",
            "node_modules/**",
            "scripts/**",
            "test/**",
            "tests/**",
            "*.config.{ts,js,mts,mjs}",
            "vite.{ts,js,mts,mjs}",
            "vitest.{ts,js,mts,mjs}",
          ],
          reporter: ["text-summary", "json-summary"],
        },
      },
      ssr: {
        resolve: {
          conditions: ["source"],
          externalConditions: ["source"],
        },
      },
    },
    config,
  );
}
