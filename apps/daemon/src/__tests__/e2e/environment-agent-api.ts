import type {
  EnvironmentAgentDeliveryRequest,
  EnvironmentAgentDeliveryResponse,
  EnvironmentAgentReplayResponse,
  EnvironmentAgentStatusSnapshot,
} from "@beanbag/environment-agent";
import type { Project, Thread, ThreadEvent } from "@beanbag/agent-core";

export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function readError(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.text(),
  };
}

export async function createProject(
  baseUrl: string,
  rootPath: string,
  name: string = "e2e-env-agent-project",
): Promise<Project> {
  return readJson<Project>(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, rootPath }),
  });
}

export async function createThread(
  baseUrl: string,
  projectId: string,
  inputText: string = "Prepare a thread for environment-agent e2e.",
): Promise<Thread> {
  return readJson<Thread>(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      input: [{ type: "text", text: inputText }],
    }),
  });
}

export async function waitForThreadStatus(
  baseUrl: string,
  threadId: string,
  expectedStatus: Thread["status"],
  timeoutMs: number = 5_000,
): Promise<Thread> {
  const deadline = Date.now() + timeoutMs;
  let lastThread: Thread | undefined;

  while (Date.now() < deadline) {
    const thread = await readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`);
    lastThread = thread;
    if (thread.status === expectedStatus) {
      return thread;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Thread ${threadId} did not reach ${expectedStatus} (last status=${lastThread?.status ?? "unknown"})`,
  );
}

export async function listThreadEvents(
  baseUrl: string,
  threadId: string,
): Promise<ThreadEvent[]> {
  return readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`);
}

export async function deliverEnvironmentAgentEvents(
  baseUrl: string,
  threadId: string,
  authorization: string,
  body: EnvironmentAgentDeliveryRequest,
): Promise<EnvironmentAgentDeliveryResponse> {
  return readJson<EnvironmentAgentDeliveryResponse>(
    `${baseUrl}/api/v1/threads/${threadId}/environment-agent/deliver`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization,
      },
      body: JSON.stringify(body),
    },
  );
}

export async function replayEnvironmentAgentEvents(
  baseUrl: string,
  threadId: string,
  opts?: { afterSequence?: number; limit?: number },
): Promise<EnvironmentAgentReplayResponse> {
  const params = new URLSearchParams();
  if (typeof opts?.afterSequence === "number") {
    params.set("afterSequence", String(opts.afterSequence));
  }
  if (typeof opts?.limit === "number") {
    params.set("limit", String(opts.limit));
  }
  const query = params.toString();
  return readJson<EnvironmentAgentReplayResponse>(
    `${baseUrl}/api/v1/threads/${threadId}/environment-agent/events${query ? `?${query}` : ""}`,
  );
}

export async function getEnvironmentAgentStatus(
  baseUrl: string,
  threadId: string,
): Promise<EnvironmentAgentStatusSnapshot> {
  return readJson<EnvironmentAgentStatusSnapshot>(
    `${baseUrl}/api/v1/threads/${threadId}/environment-agent/status`,
  );
}
