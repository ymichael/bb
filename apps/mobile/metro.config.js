const path = require("node:path");
const fs = require("node:fs");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.unstable_enablePackageExports = true;

const WORKSPACE_SCOPES = ["@bb/", "@get-bb/"];
const TS_EXTENSIONS = [".ts", ".tsx"];
const workspaceSourceRoots = ["packages", "apps", "plugins"].map((dir) =>
  path.join(workspaceRoot, dir),
);

function isWorkspaceSource(filePath) {
  return workspaceSourceRoots.some(
    (root) =>
      filePath.startsWith(root + path.sep) &&
      !filePath.includes(`${path.sep}node_modules${path.sep}`),
  );
}

function fileWithTsExtension(base) {
  for (const ext of TS_EXTENSIONS) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  for (const ext of TS_EXTENSIONS) {
    const indexPath = path.join(base, `index${ext}`);
    if (fs.existsSync(indexPath)) return indexPath;
  }
  return null;
}

function splitScopedSpecifier(moduleName) {
  const parts = moduleName.split("/");
  const packageName = parts.slice(0, 2).join("/");
  const subpath = parts.length > 2 ? "./" + parts.slice(2).join("/") : ".";
  return { packageName, subpath };
}

const workspacePackageDirCache = new Map();
function findWorkspacePackageDir(packageName) {
  if (workspacePackageDirCache.has(packageName)) {
    return workspacePackageDirCache.get(packageName);
  }
  let found = null;
  for (const nodeModules of config.resolver.nodeModulesPaths) {
    const candidate = path.join(nodeModules, packageName);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      found = fs.realpathSync(candidate);
      break;
    }
  }
  workspacePackageDirCache.set(packageName, found);
  return found;
}

function resolveWorkspaceSource(moduleName) {
  const { packageName, subpath } = splitScopedSpecifier(moduleName);
  const packageDir = findWorkspacePackageDir(packageName);
  if (!packageDir || !isWorkspaceSource(packageDir + path.sep)) return null;
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  const entry = packageJson.exports?.[subpath];
  if (!entry) return null;
  const source =
    typeof entry === "string" ? entry : (entry.source ?? entry.default);
  if (typeof source !== "string") return null;
  return path.resolve(packageDir, source);
}

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;

  if (WORKSPACE_SCOPES.some((scope) => moduleName.startsWith(scope))) {
    const filePath = resolveWorkspaceSource(moduleName);
    if (filePath && fs.existsSync(filePath)) {
      return { type: "sourceFile", filePath };
    }
  }

  if (
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js") &&
    isWorkspaceSource(context.originModulePath)
  ) {
    const base = path.resolve(
      path.dirname(context.originModulePath),
      moduleName.slice(0, -3),
    );
    const filePath = fileWithTsExtension(base);
    if (filePath) return { type: "sourceFile", filePath };
  }

  return resolve(context, moduleName, platform);
};

module.exports = withNativewind(config, { inlineRem: 16 });
