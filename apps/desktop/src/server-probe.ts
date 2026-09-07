import { z } from "zod";

const healthResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

const systemConfigResponseSchema = z
  .object({
    dataDir: z.string().min(1).optional(),
    hostDaemonPort: z.number().int().min(1).max(65_535),
    voiceTranscriptionEnabled: z.boolean(),
  })
  .passthrough();

export type ServerProbeResult =
  | CompatibleServerProbeResult
  | IncompatibleServerProbeResult
  | UnavailableServerProbeResult;

export type ServerProbeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CompatibleServerProbeResult {
  dataDir: string | null;
  kind: "compatible";
  serverUrl: string;
}

interface IncompatibleServerProbeResult {
  kind: "incompatible";
  reason: string;
  serverUrl: string;
}

interface UnavailableServerProbeResult {
  kind: "unavailable";
  reason: string;
  serverUrl: string;
}

interface ProbeBbServerArgs {
  fetchImpl?: ServerProbeFetch;
  serverUrl: string;
  timeoutMs: number;
}

interface WaitForCompatibleServerArgs {
  intervalMs: number;
  serverUrl: string;
  timeoutMs: number;
}

interface FetchJsonArgs<TValue> {
  fetchImpl: ServerProbeFetch;
  schema: z.ZodType<TValue>;
  timeoutMs: number;
  url: string;
}

type FetchJsonResult<TValue> =
  | FetchJsonHttpErrorResult
  | FetchJsonNetworkErrorResult
  | FetchJsonSchemaErrorResult
  | FetchJsonSuccessResult<TValue>;

type FetchJsonFailureResult =
  | FetchJsonHttpErrorResult
  | FetchJsonNetworkErrorResult
  | FetchJsonSchemaErrorResult;

interface FetchJsonSuccessResult<TValue> {
  kind: "success";
  value: TValue;
}

interface FetchJsonHttpErrorResult {
  kind: "http-error";
  status: number;
}

interface FetchJsonSchemaErrorResult {
  kind: "schema-error";
  message: string;
}

interface FetchJsonNetworkErrorResult {
  kind: "network-error";
  message: string;
}

interface SleepArgs {
  delayMs: number;
}

async function sleep(args: SleepArgs): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, args.delayMs);
  });
}

function endpointUrl(serverUrl: string, path: string): string {
  return new URL(path, serverUrl).toString();
}

async function fetchJson<TValue>(
  args: FetchJsonArgs<TValue>,
): Promise<FetchJsonResult<TValue>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, args.timeoutMs);

  try {
    const response = await args.fetchImpl(args.url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        kind: "http-error",
        status: response.status,
      };
    }

    const parsed = args.schema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        kind: "schema-error",
        message: parsed.error.message,
      };
    }

    return {
      kind: "success",
      value: parsed.data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "network-error",
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatFetchFailure(result: FetchJsonFailureResult): string {
  if (result.kind === "http-error") {
    return `HTTP ${result.status}`;
  }
  return result.message;
}

export async function probeBbServer(
  args: ProbeBbServerArgs,
): Promise<ServerProbeResult> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const healthResult = await fetchJson({
    fetchImpl,
    schema: healthResponseSchema,
    timeoutMs: args.timeoutMs,
    url: endpointUrl(args.serverUrl, "/health"),
  });

  if (healthResult.kind === "network-error") {
    return {
      kind: "unavailable",
      reason: healthResult.message,
      serverUrl: args.serverUrl,
    };
  }

  if (healthResult.kind !== "success") {
    return {
      kind: "incompatible",
      reason: `/health returned ${formatFetchFailure(healthResult)}`,
      serverUrl: args.serverUrl,
    };
  }

  if (!healthResult.value.ok) {
    return {
      kind: "incompatible",
      reason: "/health did not report ok=true",
      serverUrl: args.serverUrl,
    };
  }

  const configResult = await fetchJson({
    fetchImpl,
    schema: systemConfigResponseSchema,
    timeoutMs: args.timeoutMs,
    url: endpointUrl(args.serverUrl, "/api/v1/system/config"),
  });

  if (configResult.kind !== "success") {
    return {
      kind: "incompatible",
      reason: `/api/v1/system/config returned ${formatFetchFailure(configResult)}`,
      serverUrl: args.serverUrl,
    };
  }

  return {
    dataDir: configResult.value.dataDir ?? null,
    kind: "compatible",
    serverUrl: args.serverUrl,
  };
}

export async function waitForCompatibleServer(
  args: WaitForCompatibleServerArgs,
): Promise<ServerProbeResult> {
  const deadline = Date.now() + args.timeoutMs;
  let lastResult: ServerProbeResult = {
    kind: "unavailable",
    reason: "Probe has not started",
    serverUrl: args.serverUrl,
  };

  while (Date.now() <= deadline) {
    lastResult = await probeBbServer({
      serverUrl: args.serverUrl,
      timeoutMs: Math.min(args.intervalMs, 1_000),
    });

    if (lastResult.kind === "compatible") {
      return lastResult;
    }

    if (lastResult.kind === "incompatible") {
      return lastResult;
    }

    await sleep({ delayMs: args.intervalMs });
  }

  return {
    kind: "unavailable",
    reason: `Timed out after ${args.timeoutMs}ms waiting for bb server. Last probe: ${lastResult.reason}`,
    serverUrl: args.serverUrl,
  };
}
