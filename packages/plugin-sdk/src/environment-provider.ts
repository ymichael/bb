import type { Environment, Host, Project } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import type {
  JsonValue,
  PluginEnvironmentProviderRequirements,
  PluginEnvironmentValidateDecision,
  StandardSchemaV1,
  StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk";

export type PluginEnvironmentProviderInputsSchema =
  | StandardSchemaV1
  | undefined;
type Fact<R, K extends PropertyKey, T> =
  R extends Record<K, true> ? T : T | null;
type Checkout<R> = R extends { projectCheckout: true } | { gitCheckout: true }
  ? { path: string }
  : { path: string } | null;
type InputsValue<S> = S extends StandardSchemaV1
  ? StandardSchemaV1InferOutput<S>
  : null;

/** Attempt-scoped updates; core persists each update before this call returns. */
export interface PluginEnvironmentProviderProgress {
  step(text: string): void;
  log(text: string): void;
}

export interface PluginEnvironmentProviderValidateContext<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> {
  project: Project;
  host: Host;
  projectCheckout: Checkout<R>;
  gitRemote: Fact<R, "gitRemote", string>;
  inputs: InputsValue<S>;
}

export interface PluginEnvironmentProviderAvailabilityContext {
  project: Project;
  host: Host | null;
  projectCheckout: { path: string } | null;
  gitRemote: string | null;
}

export type PluginEnvironmentProviderAvailability =
  | { status: "available" }
  | { status: "setup-required"; message: string }
  | { status: "unavailable"; message: string };

export interface PluginEnvironmentProviderCreateContext<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> extends PluginEnvironmentProviderValidateContext<R, S> {
  thread: ThreadResponse;
  suggestedBranchName: string;
  attempt: number;
  pathKey: string;
  rebuild: boolean;
  /** Resource is private to this provider; null after completed removal. */
  previous: { environment: Environment; resource: JsonValue | null } | null;
  report: PluginEnvironmentProviderProgress;
  signal: AbortSignal;
}

export type PluginEnvironmentProviderCreateResult =
  | {
      status: "created";
      path: string;
      ownsPath: boolean;
      mergeBaseBranch?: string;
      resource?: JsonValue;
    }
  | { status: "failed"; failure: "transient" | "terminal"; message: string };

export interface PluginEnvironmentProviderRemoveContext {
  environment: Environment | null;
  hostId: string | null;
  path: string | null;
  pathKey: string;
  resource: JsonValue | null;
  attempt: number;
  report: PluginEnvironmentProviderProgress;
  signal: AbortSignal;
}

export type PluginEnvironmentProviderRemoveResult =
  | { status: "removed" }
  | { status: "failed"; message: string };

/** Core normalizes omitted policy members once at registration. */
export interface PluginEnvironmentProviderPolicy {
  /** Default five minutes; null keeps the environment indefinitely. */
  retireGraceMs: number | null;
  /** Default 60 seconds. */
  removeRetryMs: number;
  /** Default 30 seconds. */
  transientRetryMs: number;
  /** Default three retries. */
  transientRetryLimit: number;
  /** Default per-thread; rebuilds use a fresh key to avoid dead paths. */
  pathKeys: "per-thread" | "per-attempt";
  /** Default null; a timeout is recorded as a transient failure. */
  createTimeoutMs: number | null;
}

/** Resource operations only. Core owns durable launches, retries and retirement. */
export interface PluginEnvironmentProviderDefinition<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> {
  id: string;
  displayName: string;
  /** Host glyph, plugin-relative icon path, or this plugin’s declared namespaced icon. */
  icon?: string;
  requires?: R;
  inputs?: S;
  policy?: Partial<PluginEnvironmentProviderPolicy>;
  /** Experimental: see docs/api_to_audit.md. */
  availability?(
    context: PluginEnvironmentProviderAvailabilityContext,
  ):
    | PluginEnvironmentProviderAvailability
    | Promise<PluginEnvironmentProviderAvailability>;
  validate?(
    context: PluginEnvironmentProviderValidateContext<R, S>,
  ):
    | PluginEnvironmentValidateDecision
    | Promise<PluginEnvironmentValidateDecision>;
  create(
    context: PluginEnvironmentProviderCreateContext<R, S>,
  ): Promise<PluginEnvironmentProviderCreateResult>;
  remove(
    context: PluginEnvironmentProviderRemoveContext,
  ): Promise<PluginEnvironmentProviderRemoveResult>;
}
