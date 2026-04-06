import {
  hostDaemonEnrollResponseSchema,
  type HostDaemonEnrollRequest,
} from "@bb/host-daemon-contract";

interface EnrollHostArgs {
  fetchFn?: typeof fetch;
  hostId: string;
  hostName: string;
  hostType: HostDaemonEnrollRequest["hostType"];
  serverUrl: string;
  token: string;
}

export interface EnrollHostResult {
  hostId: string;
  hostKey: string;
}

function buildEnrollUrl(serverUrl: string): string {
  return new URL("/internal/hosts/enroll", serverUrl).toString();
}

export async function enrollDaemonHost(
  args: EnrollHostArgs,
): Promise<EnrollHostResult> {
  const fetchFn = args.fetchFn ?? fetch;
  const response = await fetchFn(buildEnrollUrl(args.serverUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hostId: args.hostId,
      hostName: args.hostName,
      hostType: args.hostType,
    }),
  });

  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(
      `Failed to enroll daemon host: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }

  return hostDaemonEnrollResponseSchema.parse(await response.json());
}
