import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  computeServiceFingerprint,
  devServiceNameValues,
  type DevServiceName,
  type RestartTarget,
} from "./fingerprint.js";

interface DevServiceStatus {
  baselineFingerprint: string;
  changed: boolean;
  fingerprint: string;
  serviceName: DevServiceName;
}

interface DevEnvStatus {
  fingerprint: string;
  services: DevServiceStatus[];
  version: 1;
}

export interface DevEnvRuntime {
  baselineFingerprints: Map<DevServiceName, string>;
}

export interface DevEnvStatusDependencies {
  computeServiceFingerprint(serviceName: DevServiceName): Promise<string>;
  runRestartScript(target: RestartTarget): Promise<void>;
}

interface CreateDefaultDependenciesArgs {
  repoRoot: string;
}

interface RunCommandArgs {
  args: string[];
  command: string;
  cwd: string;
}

const restartRequestBodySchema = z.object({
  target: z.enum(["both", "host-daemon", "server"]),
});
type RestartRequestBody = z.infer<typeof restartRequestBodySchema>;

const restartScripts: Record<RestartTarget, string> = {
  both: "dev:restart",
  "host-daemon": "dev:restart-host-daemon",
  server: "dev:restart-server",
};

function servicesForTarget(target: RestartTarget): DevServiceName[] {
  return target === "both" ? [...devServiceNameValues] : [target];
}

async function hasServiceChanged(
  dependencies: DevEnvStatusDependencies,
  runtime: DevEnvRuntime,
  serviceName: DevServiceName,
): Promise<boolean> {
  const baselineFingerprint = runtime.baselineFingerprints.get(serviceName);
  if (!baselineFingerprint) {
    throw new Error(`Missing ${serviceName} baseline fingerprint`);
  }
  return (
    baselineFingerprint !==
    (await dependencies.computeServiceFingerprint(serviceName))
  );
}

async function resolveEffectiveRestartTarget(
  dependencies: DevEnvStatusDependencies,
  runtime: DevEnvRuntime,
  requestedTarget: RestartTarget,
): Promise<RestartTarget> {
  if (requestedTarget !== "server") {
    return requestedTarget;
  }

  return (await hasServiceChanged(dependencies, runtime, "host-daemon"))
    ? "both"
    : requestedTarget;
}

function runCommand(args: RunCommandArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${args.command} exited with ${signal ?? code ?? 1}`));
    });
  });
}

async function computeStatus(
  dependencies: DevEnvStatusDependencies,
  runtime: DevEnvRuntime,
): Promise<DevEnvStatus> {
  const services = await Promise.all(
    devServiceNameValues.map(async (serviceName) => {
      const fingerprint =
        await dependencies.computeServiceFingerprint(serviceName);
      const baselineFingerprint = runtime.baselineFingerprints.get(serviceName);
      if (!baselineFingerprint) {
        throw new Error(`Missing ${serviceName} baseline fingerprint`);
      }
      return {
        baselineFingerprint,
        changed: baselineFingerprint !== fingerprint,
        fingerprint,
        serviceName,
      };
    }),
  );

  const fingerprintHash = createHash("sha256");
  for (const service of services) {
    fingerprintHash.update(service.serviceName);
    fingerprintHash.update("\0");
    fingerprintHash.update(service.fingerprint);
    fingerprintHash.update("\0");
  }
  return {
    fingerprint: fingerprintHash.digest("hex"),
    services,
    version: 1,
  };
}

async function updateBaselines(
  dependencies: DevEnvStatusDependencies,
  runtime: DevEnvRuntime,
  target: RestartTarget,
): Promise<void> {
  await Promise.all(
    servicesForTarget(target).map(async (serviceName) => {
      runtime.baselineFingerprints.set(
        serviceName,
        await dependencies.computeServiceFingerprint(serviceName),
      );
    }),
  );
}

async function parseRestartRequestBody(
  context: Context,
): Promise<RestartRequestBody> {
  try {
    return restartRequestBodySchema.parse(await context.req.json());
  } catch {
    throw new HTTPException(400, {
      message:
        'Expected JSON body with target "both", "server", or "host-daemon"',
    });
  }
}

export function createDefaultDevEnvStatusDependencies(
  args: CreateDefaultDependenciesArgs,
): DevEnvStatusDependencies {
  return {
    computeServiceFingerprint: (serviceName) =>
      computeServiceFingerprint({
        repoRoot: args.repoRoot,
        serviceName,
      }),
    runRestartScript: async (target) => {
      await runCommand({
        args: ["run", "--silent", restartScripts[target]],
        command: "pnpm",
        cwd: args.repoRoot,
      });
    },
  };
}

export async function createRuntime(
  dependencies: DevEnvStatusDependencies,
): Promise<DevEnvRuntime> {
  const baselineFingerprints = new Map<DevServiceName, string>();
  await Promise.all(
    devServiceNameValues.map(async (serviceName) => {
      baselineFingerprints.set(
        serviceName,
        await dependencies.computeServiceFingerprint(serviceName),
      );
    }),
  );
  return { baselineFingerprints };
}

export function createDevEnvStatusApp(
  runtime: DevEnvRuntime,
  dependencies: DevEnvStatusDependencies,
): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.text("ok"));
  app.get("/status", async (context) =>
    context.json(await computeStatus(dependencies, runtime)),
  );
  app.post("/restart", async (context) => {
    const body = await parseRestartRequestBody(context);
    try {
      const target = await resolveEffectiveRestartTarget(
        dependencies,
        runtime,
        body.target,
      );
      await dependencies.runRestartScript(target);
      await updateBaselines(dependencies, runtime, target);
      return context.json(await computeStatus(dependencies, runtime));
    } catch (error) {
      throw new HTTPException(409, {
        message: error instanceof Error ? error.message : "Restart failed",
      });
    }
  });

  return app;
}
