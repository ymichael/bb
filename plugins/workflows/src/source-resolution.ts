import path from "node:path";
import type { WorkflowReference } from "./types.js";
import { MAX_WORKFLOW_SOURCE_BYTES } from "./validation.js";

export { MAX_WORKFLOW_SOURCE_BYTES };

export interface WorkflowSourceInput {
  script?: string;
  source?: string;
  scriptPath?: string;
  scriptPathBase?: string;
  name?: string;
}

interface WorkflowSourceEnvironment {
  id: string;
  projectId: string;
  hostId: string;
  path: string | null;
}

export interface WorkflowSourceResolverDependencies {
  getThreadEnvironmentId(threadId: string): Promise<string | null>;
  getEnvironment(environmentId: string): Promise<WorkflowSourceEnvironment>;
  readFile(input: { hostId: string; path: string; rootPath: string }): Promise<{
    content: string;
    contentEncoding: "utf8" | "base64";
    sizeBytes: number;
  }>;
}

export type WorkflowSourceContext =
  | { projectId: string; threadId: string }
  | { projectId: string; environmentId: string };

export interface ResolvedWorkflowSource {
  source: string;
  environmentId: string;
  origin:
    | { kind: "script" }
    | { kind: "scriptPath"; path: string }
    | { kind: "name"; name: string; path: string };
}

export function workflowReferenceToSourceInput(
  reference: WorkflowReference,
): WorkflowSourceInput {
  if (typeof reference === "string") return { name: reference };
  return reference;
}

function nonEmpty(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (value.length === 0) throw new Error(`${field} must not be empty`);
  return value;
}

function parseSourceMode(
  input: WorkflowSourceInput,
):
  | { kind: "script"; source: string }
  | { kind: "scriptPath"; scriptPath: string; scriptPathBase: string | null }
  | { kind: "name"; name: string } {
  const script = nonEmpty(input.script, "script");
  const source = nonEmpty(input.source, "source");
  if (script !== null && source !== null) {
    throw new Error("script and source are aliases; provide only one of them");
  }
  const inline = script ?? source;
  const scriptPath = nonEmpty(input.scriptPath, "scriptPath");
  const name = nonEmpty(input.name, "name");
  const count = [inline, scriptPath, name].filter(
    (value) => value !== null,
  ).length;
  if (count !== 1) {
    throw new Error(
      "Exactly one workflow source is required: script, scriptPath, or name",
    );
  }
  if (inline !== null) return { kind: "script", source: inline };
  if (scriptPath !== null) {
    return {
      kind: "scriptPath",
      scriptPath,
      scriptPathBase: input.scriptPathBase ?? null,
    };
  }
  return { kind: "name", name: name! };
}

function pathFlavor(rootPath: string): typeof path.posix | typeof path.win32 {
  return /^[a-zA-Z]:[\\/]/.test(rootPath) || rootPath.startsWith("\\\\")
    ? path.win32
    : path.posix;
}

export function resolveConfinedWorkflowPath(
  rootPath: string,
  requestedPath: string,
): string {
  if (rootPath.length === 0)
    throw new Error("Workflow workspace path is empty");
  if (requestedPath.length === 0)
    throw new Error("Workflow scriptPath must not be empty");
  if (requestedPath.includes("\0"))
    throw new Error("Workflow scriptPath contains a NUL byte");

  const flavor = pathFlavor(rootPath);
  if (!flavor.isAbsolute(rootPath)) {
    throw new Error("Workflow workspace root must be an absolute path");
  }
  const otherFlavor = flavor === path.win32 ? path.posix : path.win32;
  const root = flavor.resolve(rootPath);
  if (
    otherFlavor.isAbsolute(requestedPath) &&
    !flavor.isAbsolute(requestedPath)
  ) {
    throw new Error(
      `Workflow scriptPath uses an absolute path form outside the workspace: ${requestedPath}`,
    );
  }
  const candidate = flavor.isAbsolute(requestedPath)
    ? flavor.normalize(requestedPath)
    : flavor.resolve(root, requestedPath);
  const relative = flavor.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${flavor.sep}`) ||
    flavor.isAbsolute(relative)
  ) {
    throw new Error(
      `Workflow scriptPath must stay inside the origin workspace: ${requestedPath}`,
    );
  }
  return candidate;
}

function workflowNamePath(rootPath: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      "Workflow name must be lowercase kebab-case and at most 64 characters",
    );
  }
  const flavor = pathFlavor(rootPath);
  return resolveConfinedWorkflowPath(
    rootPath,
    flavor.join(".bb", "workflows", `${name}.js`),
  );
}

async function readWorkflowFile(
  dependencies: WorkflowSourceResolverDependencies,
  environment: WorkflowSourceEnvironment,
  absolutePath: string,
): Promise<string> {
  let file;
  try {
    file = await dependencies.readFile({
      hostId: environment.hostId,
      path: absolutePath,
      rootPath: environment.path!,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read workflow source ${absolutePath}: ${detail}`,
    );
  }
  if (file.contentEncoding !== "utf8") {
    throw new Error(`Workflow source is not valid UTF-8 text: ${absolutePath}`);
  }
  if (file.sizeBytes > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(
      `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes: ${absolutePath}`,
    );
  }
  return file.content;
}

export async function resolveWorkflowSource(
  input: WorkflowSourceInput,
  context: WorkflowSourceContext,
  dependencies: WorkflowSourceResolverDependencies,
): Promise<ResolvedWorkflowSource> {
  const mode = parseSourceMode(input);
  const environmentId =
    "environmentId" in context
      ? context.environmentId
      : await dependencies.getThreadEnvironmentId(context.threadId);
  if (environmentId === null) {
    throw new Error("Workflow origin thread has no environment");
  }
  if (mode.kind === "script") {
    return {
      source: mode.source,
      environmentId,
      origin: { kind: "script" },
    };
  }
  const environment = await dependencies.getEnvironment(environmentId);
  if (environment.projectId !== context.projectId) {
    throw new Error("Workflow origin environment belongs to another project");
  }
  if (environment.path === null || environment.path.length === 0) {
    throw new Error(
      "Workflow origin environment has no workspace path for file resolution",
    );
  }
  const absolutePath =
    mode.kind === "name"
      ? workflowNamePath(environment.path, mode.name)
      : (() => {
          if (mode.scriptPathBase === null) {
            return resolveConfinedWorkflowPath(
              environment.path,
              mode.scriptPath,
            );
          }
          const flavor = pathFlavor(environment.path);
          if (flavor.isAbsolute(mode.scriptPath)) {
            return resolveConfinedWorkflowPath(
              environment.path,
              mode.scriptPath,
            );
          }
          if (!flavor.isAbsolute(mode.scriptPathBase)) {
            throw new Error("Workflow CLI cwd must be an absolute path");
          }
          const base = resolveConfinedWorkflowPath(
            environment.path,
            mode.scriptPathBase,
          );
          return resolveConfinedWorkflowPath(
            environment.path,
            flavor.resolve(base, mode.scriptPath),
          );
        })();
  const source = await readWorkflowFile(
    dependencies,
    environment,
    absolutePath,
  );
  return {
    source,
    environmentId,
    origin:
      mode.kind === "name"
        ? { kind: "name", name: mode.name, path: absolutePath }
        : { kind: "scriptPath", path: absolutePath },
  };
}
