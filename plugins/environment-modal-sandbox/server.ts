import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderCreateContext,
  PluginMachineProviderCreateResult,
  PluginMachineProviderProgress,
} from "@get-bb/plugin-sdk/machine-provider";
import {
  createTerminalOutputLineReader,
  readTerminalOutputLines,
} from "bb-environment-provider-host/terminal-output";
import {
  resolveSettings,
  SETTING_DESCRIPTORS,
  type ResolvedSettings,
} from "./configuration.js";
import {
  enrolmentScript,
  prerequisitesScript,
  providerAuthenticationScript,
  projectClonePath,
  restartSupervisorScript,
  shellCommand,
  shellQuote,
  stopSupervisorScript,
} from "./enrolment.js";
import {
  createModalBackend,
  type SandboxBackend,
  type SandboxBackendFactory,
  type SandboxHandle,
} from "./sandbox-backend.js";
import {
  resolveSandboxEnrolment,
  resolveSandboxServerUrl,
  type PreflightFetch,
} from "./enrolment-target.js";
import {
  readModalMachineResource,
  type ModalMachineResource,
} from "./lifecycle.js";

export const PROVIDER_ID = "modal-sandbox";

const HOST_CONNECT_TIMEOUT_MS = 240_000;
const HOST_POLL_INTERVAL_MS = 3_000;
const PREREQUISITES_TIMEOUT_MS = 300_000;
const ENROLMENT_TIMEOUT_MS = 600_000;
const PROVIDER_AUTHENTICATION_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 900_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;
const REMOVE_RETRY_MS = 30_000;
const RETIRE_GRACE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const FAILURE_TAIL_LINES = 12;
const FAILURE_TAIL_MAX_CHARS = 2_000;
type ProvisionProject = NonNullable<
  PluginMachineProviderCreateContext["project"]
>;

class LaunchAbortedError extends Error {}
class LaunchTerminalError extends Error {}

const TERMINAL_LAUNCH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read from remote repository|host key verification failed|permission denied \(publickey\)|repository not found|installer returned HTTP status 4\d\d/iu;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportTerminalOutput(
  report: PluginMachineProviderProgress,
  output: string,
): void {
  const lines = readTerminalOutputLines(output);
  if (lines.length > 0) report.log(lines.join("\n"));
}

export interface ModalSandboxDeps {
  backendFactory: SandboxBackendFactory;
  fetch: PreflightFetch;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

export function modalSandboxHostName(sandboxId: string): string {
  return `Modal sandbox ${sandboxId.slice(-4)}`;
}

export function createModalSandboxPlugin(
  deps: ModalSandboxDeps,
): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    let cachedBackend: { token: string; backend: SandboxBackend } | null = null;

    async function currentSettings(): Promise<
      { ok: true; settings: ResolvedSettings } | { ok: false; message: string }
    > {
      return resolveSettings(await settings.get());
    }

    function backendFor(resolved: ResolvedSettings): SandboxBackend {
      const token = `${resolved.tokenId}:${resolved.tokenSecret}`;
      if (cachedBackend?.token === token) return cachedBackend.backend;
      const backend = deps.backendFactory({
        tokenId: resolved.tokenId,
        tokenSecret: resolved.tokenSecret,
      });
      cachedBackend = { token, backend };
      return backend;
    }

    function guard(signal: AbortSignal): void {
      if (signal.aborted) throw new LaunchAbortedError("cancelled");
    }

    async function run(args: {
      sandbox: SandboxHandle;
      script: string;
      timeoutMs: number;
      what: string;
      report: PluginMachineProviderProgress;
    }) {
      const result = await args.sandbox.exec(shellCommand(args.script), {
        timeoutMs: args.timeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      reportTerminalOutput(args.report, output);
      if (result.exitCode !== 0) {
        const tail = readTerminalOutputLines(output)
          .slice(-FAILURE_TAIL_LINES)
          .join(" / ");
        const detail =
          tail.length > FAILURE_TAIL_MAX_CHARS
            ? `…${tail.slice(-FAILURE_TAIL_MAX_CHARS)}`
            : tail;
        throw new Error(
          detail.length === 0
            ? `${args.what} exited ${result.exitCode}`
            : `${args.what} exited ${result.exitCode}: ${detail}`,
        );
      }
      return result;
    }

    async function waitForHost(
      hostId: string,
      signal: AbortSignal,
      connected: boolean,
    ): Promise<void> {
      const deadline = deps.now() + HOST_CONNECT_TIMEOUT_MS;
      for (;;) {
        guard(signal);
        const host = (await bb.sdk.hosts.list()).find(
          (candidate) => candidate.id === hostId,
        );
        if (
          connected
            ? host?.status === "connected"
            : host?.status !== "connected"
        ) {
          return;
        }
        if (deps.now() >= deadline) {
          throw new Error(
            connected
              ? `host ${hostId} did not connect within ${HOST_CONNECT_TIMEOUT_MS / 1000}s`
              : `host ${hostId} remained connected after suspension`,
          );
        }
        await deps.sleep(HOST_POLL_INTERVAL_MS);
      }
    }

    async function readEnrolledHostId(
      sandbox: SandboxHandle,
    ): Promise<string | null> {
      const source =
        "const fs=require('node:fs');try{const v=JSON.parse(fs.readFileSync('/opt/bb-machine/auth.json','utf8'));if(typeof v.hostId==='string')process.stdout.write(v.hostId)}catch{}";
      const result = await sandbox.exec(
        shellCommand(`node -e ${shellQuote(source)}`),
        { timeoutMs: 10_000 },
      );
      const hostId = result.stdout.trim();
      return result.exitCode === 0 && hostId.length > 0 ? hostId : null;
    }

    async function providerCliStatusesWhenConnected(args: {
      hostId: string;
      signal: AbortSignal;
    }) {
      const deadline = deps.now() + HOST_CONNECT_TIMEOUT_MS;
      for (;;) {
        guard(args.signal);
        try {
          return await bb.sdk.hosts.providerCliStatus({
            hostId: args.hostId,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/host is not connected/iu.test(error.message) ||
            deps.now() >= deadline
          ) {
            throw error;
          }
        }
        await deps.sleep(HOST_POLL_INTERVAL_MS);
      }
    }

    async function ensureCodexReady(args: {
      hostId: string;
      sandbox: SandboxHandle;
      environmentVariables: Readonly<Record<string, string>>;
      report: PluginMachineProviderProgress;
      signal: AbortSignal;
    }): Promise<void> {
      const statuses = await providerCliStatusesWhenConnected(args);
      const status = statuses.codex;
      const action = status?.installAction;
      if (status !== undefined && action !== null) {
        const actionVerb =
          action.kind === "install" ? "Installing" : "Updating";
        args.report.step(`${actionVerb} ${status.displayName}…`);
        const events = await bb.sdk.hosts.installProviderCli({
          hostId: args.hostId,
          provider: "codex",
          actionKind: action.kind,
        });
        const outputReader = createTerminalOutputLineReader();
        for (const event of events) {
          if (event.type === "started") {
            args.report.log(`$ ${event.command}\n`);
          } else if (event.type === "output") {
            const lines = outputReader.push(event.text);
            if (lines.length > 0) args.report.log(lines.join("\n"));
          }
        }
        const remainingLines = outputReader.flush();
        if (remainingLines.length > 0) {
          args.report.log(remainingLines.join("\n"));
        }
        const completed = events.find((event) => event.type === "completed");
        if (completed?.success !== true) {
          const failure = events.find((event) => event.type === "error");
          throw new Error(
            failure?.type === "error"
              ? failure.message
              : `${actionVerb.toLowerCase()} ${status.displayName} failed`,
          );
        }
      }
      const authenticationScript = providerAuthenticationScript(
        "codex",
        args.environmentVariables,
      );
      if (authenticationScript !== null) {
        args.report.step("Authenticating Codex…");
        await run({
          sandbox: args.sandbox,
          script: authenticationScript,
          timeoutMs: PROVIDER_AUTHENTICATION_TIMEOUT_MS,
          what: "authenticating Codex",
          report: args.report,
        });
      }
      const states = await bb.sdk.system.providerStates({
        hostId: args.hostId,
      });
      const state = states.providers.find(
        (candidate) => candidate.providerId === "codex",
      );
      if (
        state === undefined ||
        state.status === "ready" ||
        state.status === "unknown"
      ) {
        return;
      }
      if (state.status === "unauthenticated" || state.status === "expired") {
        throw new LaunchTerminalError(
          `${state.displayName} is ${state.status} in the new sandbox. Add OPENAI_API_KEY or CODEX_ACCESS_TOKEN to the Modal plugin's environmentVariables JSON setting, or use an image whose root user already has a valid Codex login.`,
        );
      }
      throw new LaunchTerminalError(
        state.statusMessage ??
          `${state.displayName} is not ready in the new sandbox (${state.status}).`,
      );
    }

    async function ensureProjectSource(args: {
      hostId: string;
      project: ProvisionProject;
      gitRemote: string;
      sandbox: SandboxHandle;
      report: PluginMachineProviderProgress;
      signal: AbortSignal;
    }): Promise<string> {
      const path = projectClonePath(args.project.name);
      args.report.step(`Cloning ${args.project.name}…`);
      await run({
        sandbox: args.sandbox,
        script: [
          "set -eu",
          `mkdir -p ${shellQuote("/workspace")}`,
          `if [ -d ${shellQuote(`${path}/.git`)} ]; then`,
          `  echo ${shellQuote(`clone already present at ${path}`)}`,
          "else",
          `  git clone --progress ${shellQuote(args.gitRemote)} ${shellQuote(path)}`,
          "fi",
        ].join("\n"),
        timeoutMs: CLONE_TIMEOUT_MS,
        what: `cloning ${args.project.name}`,
        report: args.report,
      });
      guard(args.signal);
      const project = await bb.sdk.projects.get({
        projectId: args.project.id,
      });
      const existing = project.sources.find(
        (source) => source.hostId === args.hostId && source.path === path,
      );
      if (existing !== undefined) return existing.id;
      args.report.step("Registering the project checkout…");
      const source = await bb.sdk.projects.sources.add({
        projectId: args.project.id,
        hostId: args.hostId,
        type: "local_path",
        path,
      });
      return source.id;
    }

    async function launch(
      context: PluginMachineProviderCreateContext,
    ): Promise<PluginMachineProviderCreateResult> {
      const resolved = await currentSettings();
      if (!resolved.ok) {
        return {
          status: "failed",
          failure: "terminal",
          message: resolved.message,
        };
      }
      if (context.project !== null && context.project.gitRemoteUrl === null) {
        return {
          status: "failed",
          failure: "terminal",
          message: `${context.project.name} has no git remote.`,
        };
      }
      const backend = backendFor(resolved.settings);
      let sandbox: SandboxHandle | null = null;
      let hostId: string | null = null;
      try {
        guard(context.signal);
        sandbox = await backend.fromName(
          resolved.settings.appName,
          context.key,
        );
        if (sandbox === null) {
          context.report.step("Creating the Modal sandbox…");
          sandbox = await backend.create({
            appName: resolved.settings.appName,
            name: context.key,
            image: { type: "registry", reference: resolved.settings.image },
            environmentVariables: resolved.settings.environmentVariables,
            timeoutMs: resolved.settings.timeoutMs,
            cpu: resolved.settings.cpu,
            memoryMiB: resolved.settings.memoryMiB,
            tags:
              context.project === null
                ? { bbMachineKey: context.key }
                : {
                    bbMachineKey: context.key,
                    bbProjectId: context.project.id,
                  },
          });
        }
        guard(context.signal);
        context.report.step("Installing prerequisites…");
        await run({
          sandbox,
          script: prerequisitesScript(),
          timeoutMs: PREREQUISITES_TIMEOUT_MS,
          what: "installing prerequisites",
          report: context.report,
        });
        hostId = await readEnrolledHostId(sandbox);
        if (hostId === null) {
          const enrolment = await resolveSandboxEnrolment({
            bb,
            serverUrl: resolved.settings.serverUrl,
            fetch: deps.fetch,
          });
          if (!enrolment.ok) throw new LaunchTerminalError(enrolment.message);
          guard(context.signal);
          const join = await bb.sdk.hosts.createJoinCode();
          hostId = join.hostId;
          context.report.step("Enrolling the sandbox as a bb machine…");
          await run({
            sandbox,
            script: enrolmentScript({
              joinCode: join.joinCode,
              hostId,
              hostName: modalSandboxHostName(sandbox.sandboxId),
              serverUrl: enrolment.enrolment.serverUrl,
              machineCode: enrolment.enrolment.machineCode,
            }),
            timeoutMs: ENROLMENT_TIMEOUT_MS,
            what: "enrolling the sandbox",
            report: context.report,
          });
        } else {
          const connected = (await bb.sdk.hosts.list()).some(
            (host) => host.id === hostId && host.status === "connected",
          );
          if (!connected) {
            const serverUrl = await resolveSandboxServerUrl({
              bb,
              serverUrl: resolved.settings.serverUrl,
            });
            if (!serverUrl.ok) throw new LaunchTerminalError(serverUrl.message);
            context.report.step("Reconnecting the bb machine…");
            await run({
              sandbox,
              script: restartSupervisorScript(serverUrl.serverUrl),
              timeoutMs: ENROLMENT_TIMEOUT_MS,
              what: "reconnecting the bb machine",
              report: context.report,
            });
          }
        }
        context.report.step("Waiting for the machine to connect…");
        await waitForHost(hostId, context.signal, true);
        await ensureCodexReady({
          hostId,
          sandbox,
          environmentVariables: resolved.settings.environmentVariables,
          report: context.report,
          signal: context.signal,
        });
        const sourceId =
          context.project === null || context.project.gitRemoteUrl === null
            ? null
            : await ensureProjectSource({
                hostId,
                project: context.project,
                gitRemote: context.project.gitRemoteUrl,
                sandbox,
                report: context.report,
                signal: context.signal,
              });
        guard(context.signal);
        return {
          status: "created",
          hostId,
          resource: {
            version: 3,
            key: context.key,
            sandboxId: sandbox.sandboxId,
            snapshotImageId: null,
            pendingSnapshotImageIds: [],
            projectId: context.project?.id ?? null,
            sourceId,
          },
        };
      } catch (error) {
        if (context.signal.aborted || error instanceof LaunchAbortedError) {
          throw error;
        }
        const message = errorMessage(error);
        const terminal =
          error instanceof LaunchTerminalError ||
          TERMINAL_LAUNCH_FAILURE_PATTERN.test(message);
        if (terminal) {
          await sandbox?.terminate().catch(() => {});
          if (hostId !== null) {
            const host = (await bb.sdk.hosts.list()).find(
              (candidate) => candidate.id === hostId,
            );
            if (host?.machineProviderId === null) {
              await bb.sdk.hosts.delete({ hostId }).catch(() => {});
            }
          }
        }
        return {
          status: "failed",
          failure: terminal ? "terminal" : "transient",
          message,
        };
      }
    }

    async function findSandbox(
      resource: ModalMachineResource,
      resolved: ResolvedSettings,
    ): Promise<SandboxHandle | null> {
      if (resource.sandboxId !== null) {
        const byId = await backendFor(resolved).fromId(resource.sandboxId);
        if (byId !== null) return byId;
      }
      return backendFor(resolved).fromName(resolved.appName, resource.key);
    }

    async function deletePendingSnapshots(
      resource: ModalMachineResource,
      resolved: ResolvedSettings,
      checkpoint?: (resource: ModalMachineResource) => void,
    ): Promise<ModalMachineResource> {
      let current = resource;
      for (const imageId of resource.pendingSnapshotImageIds) {
        if (imageId === resource.snapshotImageId) continue;
        await backendFor(resolved).deleteSnapshot(imageId);
        current = {
          ...current,
          pendingSnapshotImageIds: current.pendingSnapshotImageIds.filter(
            (candidate) => candidate !== imageId,
          ),
        };
        checkpoint?.(current);
      }
      return current;
    }

    const configuredAtRegistration = await currentSettings();
    bb.experimental_machines.register({
      id: PROVIDER_ID,
      displayName: "Modal sandbox",
      icon: "./modal-logo.svg",
      requires: { gitRemote: true },
      environmentRow: {
        displayName: "Modal sandbox",
        environmentProviderId: "project-checkout",
      },
      policy: {
        idleSuspendMs: configuredAtRegistration.ok
          ? configuredAtRegistration.settings.idleMs
          : DEFAULT_IDLE_MS,
        retire: { after: "last-thread", graceMs: RETIRE_GRACE_MS },
        removeRetryMs: REMOVE_RETRY_MS,
      },
      async availability({ project }) {
        const resolved = await currentSettings();
        if (!resolved.ok) {
          return { status: "setup-required", message: resolved.message };
        }
        return project !== null && project.gitRemoteUrl === null
          ? {
              status: "unavailable",
              message: `${project.name} has no git remote.`,
            }
          : { status: "available" };
      },
      async validate({ project }) {
        return project !== null && project.gitRemoteUrl === null
          ? { action: "refuse", message: `${project.name} has no git remote.` }
          : { action: "accept" };
      },
      create: launch,
      async suspend(context) {
        const resource = readModalMachineResource(context.resource);
        const resolved = await currentSettings();
        if (!resolved.ok) throw new Error(resolved.message);
        const sandbox = await findSandbox(resource, resolved.settings);
        if (sandbox === null) {
          if (resource.snapshotImageId === null) {
            throw new Error("The Modal sandbox has no restorable snapshot.");
          }
          return {
            resource: await deletePendingSnapshots(
              resource,
              resolved.settings,
              context.checkpoint,
            ),
          };
        }
        context.report.step("Stopping the bb machine…");
        await run({
          sandbox,
          script: stopSupervisorScript(),
          timeoutMs: ENROLMENT_TIMEOUT_MS,
          what: "stopping the bb machine",
          report: context.report,
        });
        await waitForHost(context.hostId, context.signal, false);
        context.report.step("Saving the Modal filesystem…");
        const snapshotImageId = await sandbox.snapshotFilesystem({
          timeoutMs: SNAPSHOT_TIMEOUT_MS,
          ttlMs: null,
        });
        const checkpoint = {
          ...resource,
          snapshotImageId,
          pendingSnapshotImageIds: [
            ...new Set([
              ...resource.pendingSnapshotImageIds,
              ...(resource.snapshotImageId === null ||
              resource.snapshotImageId === snapshotImageId
                ? []
                : [resource.snapshotImageId]),
            ]),
          ],
        } satisfies ModalMachineResource;
        context.checkpoint(checkpoint);
        await sandbox.terminate();
        const suspended = { ...checkpoint, sandboxId: null };
        context.checkpoint(suspended);
        return {
          resource: await deletePendingSnapshots(
            suspended,
            resolved.settings,
            context.checkpoint,
          ),
        };
      },
      async resume(context) {
        let resource = readModalMachineResource(context.resource);
        const resolved = await currentSettings();
        if (!resolved.ok) throw new Error(resolved.message);
        resource = await deletePendingSnapshots(resource, resolved.settings);
        let sandbox = await findSandbox(resource, resolved.settings);
        if (sandbox === null) {
          if (resource.snapshotImageId === null) {
            throw new Error("The Modal sandbox has no restorable snapshot.");
          }
          context.report.step("Restoring the Modal sandbox…");
          sandbox = await backendFor(resolved.settings).create({
            appName: resolved.settings.appName,
            name: resource.key,
            image: {
              type: "snapshot",
              imageId: resource.snapshotImageId,
            },
            environmentVariables: resolved.settings.environmentVariables,
            timeoutMs: resolved.settings.timeoutMs,
            cpu: resolved.settings.cpu,
            memoryMiB: resolved.settings.memoryMiB,
            tags:
              resource.projectId === null
                ? { bbMachineKey: resource.key }
                : {
                    bbMachineKey: resource.key,
                    bbProjectId: resource.projectId,
                  },
          });
        }
        const connected = (await bb.sdk.hosts.list()).some(
          (host) => host.id === context.hostId && host.status === "connected",
        );
        if (connected) {
          return {
            resource: { ...resource, sandboxId: sandbox.sandboxId },
          };
        }
        const serverUrl = await resolveSandboxServerUrl({
          bb,
          serverUrl: resolved.settings.serverUrl,
        });
        if (!serverUrl.ok) throw new Error(serverUrl.message);
        await run({
          sandbox,
          script: restartSupervisorScript(serverUrl.serverUrl),
          timeoutMs: ENROLMENT_TIMEOUT_MS,
          what: "restarting the bb machine",
          report: context.report,
        });
        await waitForHost(context.hostId, context.signal, true);
        return {
          resource: { ...resource, sandboxId: sandbox.sandboxId },
        };
      },
      async remove(context) {
        const resource = readModalMachineResource(context.resource);
        const resolved = await currentSettings();
        if (!resolved.ok)
          return { status: "failed", message: resolved.message };
        try {
          const sandbox = await findSandbox(resource, resolved.settings);
          await sandbox?.terminate();
          const snapshots = new Set(resource.pendingSnapshotImageIds);
          if (resource.snapshotImageId !== null) {
            snapshots.add(resource.snapshotImageId);
          }
          for (const imageId of snapshots) {
            await backendFor(resolved.settings).deleteSnapshot(imageId);
          }
          if (resource.projectId !== null && resource.sourceId !== null) {
            await bb.sdk.projects.sources
              .delete({
                projectId: resource.projectId,
                sourceId: resource.sourceId,
              })
              .catch((error) => {
                if (!/404|not found|unavailable/iu.test(errorMessage(error))) {
                  throw error;
                }
              });
          }
          return { status: "removed" };
        } catch (error) {
          return { status: "failed", message: errorMessage(error) };
        }
      },
    });

    const loaded = await currentSettings();
    if (!loaded.ok) bb.status.needsConfiguration(loaded.message);
  };
}

export default createModalSandboxPlugin({
  backendFactory: createModalBackend,
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      text: () => response.text(),
    };
  },
});
