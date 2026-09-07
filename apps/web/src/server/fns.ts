import { createServerFn } from "@tanstack/react-start";
import {
  checkAvailability,
  claimHandle,
  createConnectCode,
  createServer,
  depsFromEnv,
  disconnectServer,
  removeServer,
  revokeMachine,
  getAccountState,
  type AccountState,
} from "./api.js";
import { getEnv } from "./env.js";
import { getSessionUserId } from "./current-user.server.js";
import { resolveDevEmailPasswordEnabled } from "./local-auth.js";

type DashboardState =
  | { authed: false; emailPasswordEnabled: boolean }
  | ({ authed: true } & AccountState);

export const getDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardState> => {
    const env = getEnv();
    const userId = await getSessionUserId();
    if (!userId) {
      return {
        authed: false,
        emailPasswordEnabled: resolveDevEmailPasswordEnabled(env),
      };
    }
    return {
      authed: true,
      ...(await getAccountState(depsFromEnv(env), userId)),
    };
  },
);

export const claimHandleFn = createServerFn({ method: "POST" })
  .validator((handle: string) => String(handle))
  .handler(async ({ data: handle }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    return claimHandle(depsFromEnv(getEnv()), userId, handle);
  });

export const checkAvailabilityFn = createServerFn({ method: "POST" })
  .validator((label: string) => String(label))
  .handler(async ({ data: label }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    return checkAvailability(depsFromEnv(getEnv()), label);
  });

export const createServerRowFn = createServerFn({ method: "POST" })
  .validator((label: string) => String(label))
  .handler(async ({ data: label }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    return createServer(depsFromEnv(getEnv()), userId, label);
  });

export const createCodeFn = createServerFn({ method: "POST" })
  .validator((input: { serverId?: string; reuse?: boolean } | undefined) => ({
    serverId: typeof input?.serverId === "string" ? input.serverId : undefined,
    reuse: input?.reuse === true,
  }))
  .handler(async ({ data }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    return createConnectCode(depsFromEnv(getEnv()), userId, data);
  });

export const disconnectFn = createServerFn({ method: "POST" })
  .validator((input: { serverId: string }) => ({
    serverId: String(input.serverId),
  }))
  .handler(async ({ data }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    if (!data.serverId) return { error: "not-found" as const };
    return disconnectServer(depsFromEnv(getEnv()), userId, data.serverId);
  });

export const removeServerFn = createServerFn({ method: "POST" })
  .validator((input: { serverId: string }) => ({
    serverId: String(input.serverId),
  }))
  .handler(async ({ data }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    if (!data.serverId) return { error: "not-found" as const };
    return removeServer(depsFromEnv(getEnv()), userId, data.serverId);
  });

export const revokeMachineFn = createServerFn({ method: "POST" })
  .validator((machineId: string) => String(machineId))
  .handler(async ({ data: machineId }) => {
    const userId = await getSessionUserId();
    if (!userId) return { error: "unauthenticated" as const };
    if (!machineId) return { error: "not-found" as const };
    return revokeMachine(depsFromEnv(getEnv()), userId, machineId);
  });
