import type { Project } from "@bb/domain";
import type {
  JsonValue,
  PluginMachineProviderRequirements,
  PluginMachineValidateDecision,
  StandardSchemaV1,
  StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk";

export type PluginMachineProviderInputsSchema = StandardSchemaV1 | undefined;
type InputsValue<S> = S extends StandardSchemaV1
  ? StandardSchemaV1InferOutput<S>
  : null;
type ProjectFacts<R extends PluginMachineProviderRequirements> =
  | { project: null; gitRemote: null }
  | (R extends Record<"gitRemote", true>
      ? { project: Project; gitRemote: string }
      : { project: Project; gitRemote: string | null });

export interface PluginMachineProviderProgress {
  step(text: string): void;
  log(text: string): void;
}

export interface PluginMachineProviderAvailabilityContext {
  project: Project | null;
  gitRemote: string | null;
}

export type PluginMachineProviderAvailability =
  | { status: "available" }
  | { status: "setup-required"; message: string }
  | { status: "unavailable"; message: string };

export type PluginMachineProviderValidateContext<
  R extends PluginMachineProviderRequirements =
    PluginMachineProviderRequirements,
  S extends PluginMachineProviderInputsSchema =
    PluginMachineProviderInputsSchema,
> = ProjectFacts<R> & {
  inputs: InputsValue<S>;
};

export type PluginMachineProviderCreateContext<
  R extends PluginMachineProviderRequirements =
    PluginMachineProviderRequirements,
  S extends PluginMachineProviderInputsSchema =
    PluginMachineProviderInputsSchema,
> = PluginMachineProviderValidateContext<R, S> & {
  key: string;
  attempt: number;
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
};

export type PluginMachineProviderCreateResult =
  | { status: "created"; hostId: string; resource: JsonValue }
  | { status: "failed"; failure: "transient" | "terminal"; message: string };

export interface PluginMachineProviderLifecycleContext {
  hostId: string;
  resource: JsonValue;
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
}

export interface PluginMachineProviderSuspendContext extends PluginMachineProviderLifecycleContext {
  checkpoint(resource: JsonValue): void;
}

export interface PluginMachineProviderResourceResult {
  resource: JsonValue;
}

export type PluginMachineProviderRemoveResult =
  | { status: "removed" }
  | { status: "failed"; message: string };

export interface PluginMachineProviderEnvironmentRow {
  displayName: string;
  environmentProviderId: string;
}

export interface PluginMachineProviderPolicy {
  idleSuspendMs: number | null;
  retire: { after: "last-thread"; graceMs: number } | { after: "never" };
  removeRetryMs: number;
}

export interface PluginMachineProviderDefinition<
  R extends PluginMachineProviderRequirements =
    PluginMachineProviderRequirements,
  S extends PluginMachineProviderInputsSchema =
    PluginMachineProviderInputsSchema,
> {
  id: string;
  displayName: string;
  /** Omit to present provider-created machines like ordinary enrolled machines. */
  icon?: string;
  requires?: R;
  /** Persisted and readable by every plugin. Store secret references, never secrets. */
  inputs?: S;
  availability?(
    context: PluginMachineProviderAvailabilityContext,
  ):
    | PluginMachineProviderAvailability
    | Promise<PluginMachineProviderAvailability>;
  validate?(
    context: PluginMachineProviderValidateContext<R, S>,
  ): PluginMachineValidateDecision | Promise<PluginMachineValidateDecision>;
  environmentRow?: PluginMachineProviderEnvironmentRow;
  policy: PluginMachineProviderPolicy;
  create(
    context: PluginMachineProviderCreateContext<R, S>,
  ): Promise<PluginMachineProviderCreateResult>;
  suspend?(
    context: PluginMachineProviderSuspendContext,
  ): Promise<PluginMachineProviderResourceResult>;
  resume?(
    context: PluginMachineProviderLifecycleContext,
  ): Promise<PluginMachineProviderResourceResult>;
  remove(
    context: PluginMachineProviderLifecycleContext,
  ): Promise<PluginMachineProviderRemoveResult>;
}
