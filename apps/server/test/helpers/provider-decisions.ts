import { jsonValueSchema, type JsonValue } from "@bb/domain";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderCreateContext } from "@get-bb/plugin-sdk/environment-provider";
import type { ProviderReadyEnvironmentInput } from "@bb/server-contract";

export type TestProviderDecision =
  | {
      action: "ready";
      environment: ProviderReadyEnvironmentInput;
      log?: string;
    }
  | { action: "wait"; reason: string; log?: string }
  | { action: "reject"; message: string };

type GenericCreateContext = PluginEnvironmentProviderCreateContext;
export type TestEnvironmentProviderContext = Pick<
  GenericCreateContext,
  | "thread"
  | "project"
  | "host"
  | "projectCheckout"
  | "gitRemote"
  | "suggestedBranchName"
> & {
  machine: import("@bb/domain").EnvironmentMachineSelection;
  inputs: JsonValue | null;
  environment:
    | NonNullable<GenericCreateContext["previous"]>["environment"]
    | null;
};

export function providerOperations(
  decide: (
    context: TestEnvironmentProviderContext,
  ) => TestProviderDecision | Promise<TestProviderDecision>,
): Pick<PluginEnvironmentProviderDeclaration, "create" | "remove"> {
  async function run(
    context: TestEnvironmentProviderContext,
    report: Parameters<
      PluginEnvironmentProviderDeclaration["create"]
    >[0]["report"],
    signal: AbortSignal,
  ): Promise<
    Awaited<ReturnType<PluginEnvironmentProviderDeclaration["create"]>>
  > {
    while (!signal.aborted) {
      const decision = await decide(context);
      if (decision.action === "reject")
        return {
          status: "failed",
          failure: "terminal",
          message: decision.message,
        };
      if (decision.log !== undefined) report.log(decision.log);
      if (decision.action === "wait") {
        report.step(decision.reason);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (decision.environment.type !== "host")
        return {
          status: "failed",
          failure: "terminal",
          message: "Providers return directories, not reuse decisions",
        };
      return {
        status: "created",
        path: decision.environment.path,
        ownsPath: decision.environment.ownsPath ?? true,
        ...(decision.environment.mergeBaseBranch === undefined
          ? {}
          : { mergeBaseBranch: decision.environment.mergeBaseBranch }),
      };
    }
    throw new Error("Environment creation aborted");
  }
  return {
    create: async (context) => {
      const facts = {
        ...context,
        machine: { type: "existing" as const, hostId: context.host.id },
        inputs: jsonValueSchema.parse(context.inputs),
        environment: context.previous?.environment ?? null,
      };
      return run(facts, context.report, context.signal);
    },
    remove: async () => ({ status: "removed" }),
  };
}
