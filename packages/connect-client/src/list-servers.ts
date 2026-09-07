import { z } from "zod";
import type { ConnectCredential } from "./credential.js";
import { deriveConnectBaseUrl, serverUrlForHandle } from "./urls.js";
import { ConnectListError } from "./errors.js";

const accountServerSchema = z.object({
  handle: z.string().min(1),
  name: z.string().min(1),
  live: z.boolean(),
});

const accountServersResponseSchema = z.object({
  servers: z.array(accountServerSchema),
});

type AccountServer = z.infer<typeof accountServerSchema>;

export type AccountServerWithUrl = AccountServer & {
  url: string;
};

export type ListAccountServersResult = {
  servers: AccountServerWithUrl[];
  selfHandle: string;
};

function withAccountServerUrls(
  servers: AccountServer[],
  credential: ConnectCredential,
): AccountServerWithUrl[] {
  const base = deriveConnectBaseUrl(credential.serverUrl);
  return servers.map((server) => ({
    ...server,
    url: serverUrlForHandle(base, server.handle),
  }));
}

async function fetchAccountServers(
  credential: ConnectCredential,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AccountServer[]> {
  const url = `${credential.serverUrl.replace(/\/$/, "")}/api/connect/servers`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { "x-bb-connect-machine": credential.credential },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConnectListError("network", message);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ConnectListError(
      "unauthorized",
      `List servers failed (${res.status}): not authorized`,
    );
  }
  if (!res.ok) {
    throw new ConnectListError(
      "network",
      `List servers failed (${res.status})`,
    );
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ConnectListError(
      "invalid_response",
      "List servers returned non-JSON",
    );
  }

  const parsed = accountServersResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConnectListError(
      "invalid_response",
      "List servers response failed schema validation",
    );
  }
  return parsed.data.servers;
}

export async function listAccountServers(
  credential: ConnectCredential,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ListAccountServersResult> {
  const servers = withAccountServerUrls(
    await fetchAccountServers(credential, fetchImpl),
    credential,
  );
  return { servers, selfHandle: credential.handle };
}
