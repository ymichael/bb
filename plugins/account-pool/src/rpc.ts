import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountAddInputSchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountSchema,
  accountSummarySchema,
  bypassInputSchema,
  bypassResultSchema,
  codexLoginCancelSchema,
  codexLoginPollInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  hubTokenSummarySchema,
  loginCompleteInputSchema,
  loginStartSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

export const accountPoolRpcContract = defineRpcContract({
  "account.add": {
    input: accountAddInputSchema,
    output: accountSchema,
  },
  "account.list": {
    input: z.null(),
    output: z.array(accountSummarySchema),
  },
  "account.remove": {
    input: accountIdInputSchema,
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "account.enable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.disable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setPriority": {
    input: accountPriorityInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.reorder": {
    input: accountReorderInputSchema,
    output: z.null(),
  },
  "account.refreshUsage": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ account: accountSummarySchema.nullable() }).strict(),
  },
  "routing.set": {
    input: routingSetInputSchema,
    output: z
      .object({ provider: z.enum(["claude", "codex"]), enabled: z.boolean() })
      .strict(),
  },
  "config.get": {
    input: z.null(),
    output: accountPoolConfigSchema,
  },
  "config.set": {
    input: accountPoolConfigSetInputSchema,
    output: accountPoolConfigSchema,
  },
  "login.start": {
    input: z.null(),
    output: loginStartSchema,
  },
  "login.complete": {
    input: loginCompleteInputSchema,
    output: accountSchema,
  },
  "codexLogin.start": {
    input: z.null(),
    output: codexLoginStartSchema,
  },
  "codexLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "codexLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "status.get": {
    input: z.null(),
    output: statusSchema,
  },
  "token.rotate": {
    input: tokenRotateInputSchema,
    output: hubTokenSummarySchema,
  },
  "bypass.set": {
    input: bypassInputSchema,
    output: bypassResultSchema,
  },
});

export function createRpcHandlers(
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
) {
  return {
    "account.add": (input: Parameters<PoolOperations["add"]>[0]) =>
      operations.add(input),
    "account.list": () => operations.list(),
    "account.remove": async ({ id }: { id: string }) => ({
      removed: await operations.remove(id),
    }),
    "account.enable": async ({ id }: { id: string }) => ({
      account: await operations.enable(id),
    }),
    "account.disable": async ({ id }: { id: string }) => ({
      account: await operations.disable(id),
    }),
    "account.setPriority": async ({
      accountId,
      priority,
    }: {
      accountId: string;
      priority: number;
    }) => ({
      account: await operations.setPriority(accountId, priority),
    }),
    "account.refreshUsage": async ({ accountId }: { accountId: string }) => ({
      account: await operations.refreshUsage(accountId),
    }),
    "account.reorder": async ({
      provider,
      accountIds,
    }: z.infer<typeof accountReorderInputSchema>) => {
      await operations.reorder(provider, accountIds);
      return null;
    },
    "routing.set": async ({
      provider,
      enabled,
    }: {
      provider: "claude" | "codex";
      enabled: boolean;
    }) => {
      await operations.setRouting(provider, enabled);
      return { provider, enabled };
    },
    "config.get": () => config.get(),
    "config.set": (input: Parameters<AccountPoolConfigController["set"]>[0]) =>
      config.set(input),
    "login.start": () => login.start(),
    "login.complete": (input: { sessionId: string; pasted: string }) =>
      login.complete(input),
    "codexLogin.start": () => codexLogin.start(),
    "codexLogin.poll": (input: { sessionId: string }) => codexLogin.poll(input),
    "codexLogin.cancel": (input: { sessionId: string }) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "token.rotate": ({ machine }: { machine: string }) =>
      operations.rotateToken(machine),
    "bypass.set": ({
      threadId,
      bypassed,
    }: {
      threadId: string;
      bypassed: boolean;
    }) => operations.setBypass(threadId, bypassed),
  };
}
