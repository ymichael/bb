import { z } from "zod";
import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  ConnectListError,
  type DesktopSession,
  type ListAccountServersResult,
} from "@bb/connect-client";
import { ConnectPairError } from "./redeem.js";
import type { ConnectTunnel } from "./tunnel.js";
import type { ConnectStatus } from "./types.js";
import { MachineCodeError, type MachineCode } from "./machine-code.js";
import type { ShareHostResolver } from "./hosts.js";
import type { ShareListing } from "./shares.js";

const pairInputSchema = z.object({
  code: z.string().min(1),
  server: z.string().url().optional(),
  baseUrl: z.string().url().optional(),
});

const portInputSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    hostId: z.string().min(1).optional(),
  })
  .strict();
const revokeMachineInputSchema = z.object({ machineId: z.string().min(1) });

const connectShareStatusSchema = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    port: z.number().int(),
    createdAt: z.number(),
    url: z.string(),
    unavailableReason: z.string().optional(),
  })
  .strict();

const connectStatusSchema: z.ZodType<ConnectStatus> = z
  .object({
    state: z.enum(["disconnected", "pairing", "connected", "reconnecting"]),
    paired: z.boolean(),
    handle: z.string().nullable(),
    url: z.string().nullable(),
    dashboardUrl: z.string(),
    lastError: z.string().nullable(),
    nextRetryAt: z.number().nullable(),
    since: z.number(),
    remoteClients: z.number().int(),
    lastRemoteActivityAt: z.number().nullable(),
    shares: z.array(connectShareStatusSchema),
  })
  .strict();

const shareListingSchema: z.ZodType<ShareListing> = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    port: z.number().int(),
    createdAt: z.number(),
    url: z.string(),
    unavailableReason: z.string().optional(),
  })
  .strict();

const listAccountServersResultSchema: z.ZodType<ListAccountServersResult> = z
  .object({
    servers: z.array(
      z
        .object({
          handle: z.string(),
          name: z.string(),
          live: z.boolean(),
          url: z.string(),
        })
        .strict(),
    ),
    selfHandle: z.string(),
  })
  .strict();

const desktopSessionSchema: z.ZodType<DesktopSession> = z
  .object({
    cookie: z
      .object({
        domain: z.string(),
        expiresAt: z.number().int(),
        name: z.string(),
        value: z.string(),
      })
      .strict(),
  })
  .strict();

const mobilePairingSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const machineCodeSchema: z.ZodType<MachineCode> = z
  .object({
    code: z.string(),
    expiresAt: z.number(),
    serverUrl: z.string(),
  })
  .strict();

export const connectRpcContract = defineRpcContract({
  pair: { input: pairInputSchema, output: connectStatusSchema },
  status: { input: z.null(), output: connectStatusSchema },
  disconnect: { input: z.null(), output: connectStatusSchema },
  expose: { input: portInputSchema, output: shareListingSchema },
  unexpose: {
    input: portInputSchema,
    output: z
      .object({
        removed: z.boolean(),
        hostId: z.string(),
        hostName: z.string(),
        port: z.number().int(),
      })
      .strict(),
  },
  listShares: { input: z.null(), output: z.array(shareListingSchema) },
  listAccountServers: {
    input: z.null(),
    output: listAccountServersResultSchema,
  },
  createDesktopSession: { input: z.null(), output: desktopSessionSchema },
  mobilePairing: { input: z.null(), output: mobilePairingSchema },
  createMachineCode: { input: z.null(), output: machineCodeSchema },
  revokeMachine: {
    input: revokeMachineInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

type ConnectRpcHandlers = PluginRpcHandlers<typeof connectRpcContract>;

export interface MobilePairingGate {
  enabled(): Promise<boolean>;
}

export function createRpcHandlers(
  tunnel: ConnectTunnel,
  hostResolver: ShareHostResolver,
  mobilePairing: MobilePairingGate,
): ConnectRpcHandlers {
  return {
    async pair(args) {
      try {
        return await tunnel.pair({
          code: args.code,
          ...(args.server !== undefined ? { serverUrl: args.server } : {}),
          ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
        });
      } catch (error) {
        if (error instanceof ConnectPairError) {
          throw new Error(error.code);
        }
        throw error;
      }
    },
    async status() {
      return tunnel.refreshStatus();
    },
    async disconnect() {
      return tunnel.disconnect();
    },
    async expose(args) {
      const host =
        args.hostId === undefined
          ? await hostResolver.serverHost()
          : await hostResolver.byId(args.hostId);
      return tunnel.expose(args.port, host);
    },
    async unexpose(args) {
      return tunnel.unexpose(
        args.port,
        args.hostId ?? (await hostResolver.serverHostId()),
      );
    },
    async listShares() {
      return tunnel.listShares();
    },
    async listAccountServers() {
      try {
        return await tunnel.listAccountServers();
      } catch (error) {
        if (error instanceof ConnectListError) {
          throw new Error(error.code);
        }
        throw error;
      }
    },
    async createDesktopSession() {
      try {
        return await tunnel.createDesktopSession();
      } catch (error) {
        if (error instanceof ConnectListError) {
          throw new Error(error.code);
        }
        throw error;
      }
    },
    async mobilePairing() {
      return { enabled: await mobilePairing.enabled() };
    },
    async createMachineCode() {
      try {
        return await tunnel.createMachineCode();
      } catch (error) {
        if (error instanceof MachineCodeError) {
          throw new Error(error.code);
        }
        throw error;
      }
    },
    async revokeMachine(args) {
      await tunnel.revokeMachine(args.machineId);
      return { ok: true };
    },
  };
}
