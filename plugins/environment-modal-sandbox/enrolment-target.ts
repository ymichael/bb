import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const CONNECT_PLUGIN_ID = "connect";
export const PREFLIGHT_TIMEOUT_MS = 15_000;
export const INSTALLER_CONTENT_TYPE = "text/x-shellscript";

export const NOT_REACHABLE_MESSAGE =
  "Modal sandbox has no URL a sandbox can reach this bb at. Pair this bb with bb connect (Settings → Remote access, or `bb connect --code <code> --server <server>`) so sandboxes can reach it at https://<handle>.getbb.app, or set the Modal sandbox plugin's serverUrl to a tunnel URL the sandbox can reach. A bb connect port share is not enough: port shares sit behind connect's browser login, so a sandbox gets a login page instead of the installer.";

export interface SandboxEnrolment {
  serverUrl: string;
  machineCode: string | null;
}

export type SandboxEnrolmentResolution =
  | { ok: true; enrolment: SandboxEnrolment }
  | { ok: false; message: string };

export type PreflightFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{
  status: number;
  contentType: string | null;
  text: () => Promise<string>;
}>;

const connectStatusSchema = z.looseObject({
  paired: z.boolean(),
  url: z.string().nullable(),
});

const connectMachineCodeSchema = z.looseObject({
  code: z.string().min(1),
});

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return "an empty body";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

async function resolveThroughConnect(
  bb: BbPluginApi,
): Promise<SandboxEnrolmentResolution> {
  let status: z.infer<typeof connectStatusSchema>;
  try {
    status = await bb.sdk.plugins.callRpc({
      pluginId: CONNECT_PLUGIN_ID,
      method: "status",
      input: null,
      outputSchema: connectStatusSchema,
    });
  } catch {
    return { ok: false, message: NOT_REACHABLE_MESSAGE };
  }
  if (!status.paired || status.url === null) {
    return { ok: false, message: NOT_REACHABLE_MESSAGE };
  }

  let code: string;
  try {
    const minted = await bb.sdk.plugins.callRpc({
      pluginId: CONNECT_PLUGIN_ID,
      method: "createMachineCode",
      input: null,
      outputSchema: connectMachineCodeSchema,
    });
    code = minted.code;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Modal sandbox could not mint a bb connect machine code for the sandbox: ${detail}`,
    };
  }
  return {
    ok: true,
    enrolment: { serverUrl: trimUrl(status.url), machineCode: code },
  };
}

export async function resolveSandboxServerUrl(args: {
  bb: BbPluginApi;
  serverUrl: string | null;
}): Promise<{ ok: true; serverUrl: string } | { ok: false; message: string }> {
  if (args.serverUrl !== null) {
    return { ok: true, serverUrl: trimUrl(args.serverUrl) };
  }
  try {
    const status = await args.bb.sdk.plugins.callRpc({
      pluginId: CONNECT_PLUGIN_ID,
      method: "status",
      input: null,
      outputSchema: connectStatusSchema,
    });
    return status.paired && status.url !== null
      ? { ok: true, serverUrl: trimUrl(status.url) }
      : { ok: false, message: NOT_REACHABLE_MESSAGE };
  } catch {
    return { ok: false, message: NOT_REACHABLE_MESSAGE };
  }
}

export async function preflightInstaller(args: {
  serverUrl: string;
  fetch: PreflightFetch;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const url = `${args.serverUrl}/install.sh`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const response = await args.fetch(url, { signal: controller.signal });
    if (response.status !== 200) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        message: `Modal sandbox cannot enrol through ${url}: it answered HTTP ${response.status} — ${firstLine(body)}. A sandbox needs a URL that serves bb's installer without a login.`,
      };
    }
    const contentType = response.contentType ?? "";
    if (!contentType.includes(INSTALLER_CONTENT_TYPE)) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        message: `Modal sandbox cannot enrol through ${url}: it answered 200 with content-type "${contentType.length === 0 ? "none" : contentType}" instead of ${INSTALLER_CONTENT_TYPE} — ${firstLine(body)}. That URL is not a bb server's installer.`,
      };
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Modal sandbox could not reach ${url}: ${detail}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveSandboxEnrolment(args: {
  bb: BbPluginApi;
  serverUrl: string | null;
  fetch: PreflightFetch;
}): Promise<SandboxEnrolmentResolution> {
  const resolution: SandboxEnrolmentResolution =
    args.serverUrl === null
      ? await resolveThroughConnect(args.bb)
      : {
          ok: true,
          enrolment: { serverUrl: trimUrl(args.serverUrl), machineCode: null },
        };
  if (!resolution.ok) return resolution;
  const preflight = await preflightInstaller({
    serverUrl: resolution.enrolment.serverUrl,
    fetch: args.fetch,
  });
  return preflight.ok ? resolution : { ok: false, message: preflight.message };
}
