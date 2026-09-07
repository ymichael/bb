import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
  workspaceOpenTargetsResponseSchema,
  type OpenInTargetRequest,
  type StatusResponse,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract/local";
import { z } from "zod";

let client: ReturnType<typeof createHostDaemonLocalClient> | null = null;
let clientPort: number | null = null;

export interface HostDaemonStatusSnapshot extends StatusResponse {}

const hostDaemonErrorResponseSchema = z.object({
  message: z.string().min(1),
});

function getHostDaemonClient(port: number) {
  if (!client || clientPort !== port) {
    client = createHostDaemonLocalClient(
      `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${port}`,
    );
    clientPort = port;
  }
  return client;
}

export async function fetchHostStatus(
  port: number,
): Promise<HostDaemonStatusSnapshot | null> {
  try {
    const daemon = getHostDaemonClient(port);
    const res = await daemon.status.$get();
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchWorkspaceOpenTargets(
  port: number,
  options: { path?: string } = {},
): Promise<WorkspaceOpenTarget[]> {
  const daemon = getHostDaemonClient(port);
  const res = await daemon["workspace-open-targets"].$get({
    query: options.path === undefined ? {} : { path: options.path },
  });
  const status = Number(res.status);
  if (status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Workspace open target discovery failed: HTTP ${status}`);
  }
  const body = await res.json();
  return workspaceOpenTargetsResponseSchema.parse(body).targets;
}

export async function openInTarget(
  port: number,
  request: OpenInTargetRequest,
): Promise<void> {
  const daemon = getHostDaemonClient(port);
  const res = await daemon["open-in-target"].$post({
    json: request,
  });
  if (!res.ok) {
    const status = Number(res.status);
    throw new Error(
      await readHostDaemonErrorMessage(
        res,
        `Failed to open target: HTTP ${status}`,
      ),
    );
  }
}

async function readHostDaemonErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text().catch(() => "");
  const trimmedText = text.trim();
  if (trimmedText === "") {
    return fallbackMessage;
  }

  try {
    const parsed = hostDaemonErrorResponseSchema.safeParse(
      JSON.parse(trimmedText),
    );
    if (parsed.success) {
      return parsed.data.message;
    }
  } catch {
    return trimmedText;
  }

  return trimmedText;
}
