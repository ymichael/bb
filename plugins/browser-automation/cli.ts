import { z } from "zod";
import { rpcContract } from "./contracts.js";

export const commands = [
  {
    name: "open",
    summary:
      "Open an isolated desktop or local headless session; --tab explicitly hands off an existing tab",
    usage:
      "bb browser-automation open --backend desktop --machine <host-id> --desktop <instance-id> [--tab <tab-id>] [--thread <id>] [--json] | open --backend local --headless --machine <host-id> [--thread <id>] [--json]",
  },
  {
    name: "list",
    summary: "List this thread's browser sessions",
    usage: "bb browser-automation list [--thread <id>] [--json]",
  },
  {
    name: "run",
    summary: "Run a trusted DevBrowser script; runs serialize per session",
    usage:
      "bb browser-automation run <session-id> (--script <code> | --script-file <path> --script-host <host-id>) [--timeout-ms <1000..120000>] [--thread <id>] [--json]",
  },
  {
    name: "pages",
    summary: "Inspect persistent named pages",
    usage: "bb browser-automation pages <session-id> [--thread <id>] [--json]",
  },
  {
    name: "screenshot",
    summary: "Save a bounded JPEG in session tmp; return its path and host ID",
    usage:
      "bb browser-automation screenshot <session-id> [--page <name>] [--thread <id>] [--json]",
  },
  {
    name: "stop",
    summary:
      "Cancel queued and running work and release control; open a new session to resume",
    usage: "bb browser-automation stop <session-id> [--thread <id>] [--json]",
  },
  {
    name: "close",
    summary: "Dispose owned browsers and tabs, preserving handed-off tabs",
    usage: "bb browser-automation close <session-id> [--thread <id>] [--json]",
  },
];
const methodSchema = z.enum([
  "open",
  "list",
  "run",
  "pages",
  "screenshot",
  "stop",
  "close",
]);

export function parseCli(argv: string[], contextThreadId?: string) {
  const method = methodSchema.parse(argv[0]);
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  const allowed = new Set([
    "--json",
    "--thread",
    ...(method === "open"
      ? ["--backend", "--machine", "--desktop", "--tab", "--headless"]
      : method === "run"
        ? ["--script", "--script-file", "--script-host", "--timeout-ms"]
        : method === "screenshot"
          ? ["--page"]
          : []),
  ]);
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!allowed.has(arg) || flags.has(arg))
      throw new Error(`Unknown or duplicate flag: ${arg}`);
    if (arg === "--json" || arg === "--headless") flags.set(arg, "true");
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      flags.set(arg, value);
    }
  }
  const threadId = flags.get("--thread") ?? contextThreadId;
  if (!threadId) throw new Error("Run from a BB thread or pass --thread <id>");
  if (contextThreadId && threadId !== contextThreadId)
    throw new Error(
      "CLI calls from a thread cannot access another thread's browser session",
    );
  const input: {
    threadId: string;
    sessionId?: string;
    selection?: z.input<typeof rpcContract.open.input>["selection"];
    script?: string;
    timeoutMs?: number;
    page?: string;
  } = { threadId };
  if (method === "open" || method === "list") {
    if (positionals.length) throw new Error("Unexpected positional argument");
  } else {
    if (positionals.length !== 1) throw new Error("Expected one session ID");
    input.sessionId = positionals[0];
  }
  if (method === "open") {
    const hostId = flags.get("--machine");
    if (!hostId)
      throw new Error("Select the browser host with --machine <host-id>");
    const backend = flags.get("--backend");
    if (backend === "local") {
      if (
        !flags.has("--headless") ||
        flags.has("--desktop") ||
        flags.has("--tab")
      )
        throw new Error(
          "Local sessions require --headless and cannot select desktop tabs",
        );
      input.selection = { backend, hostId };
    } else if (backend === "desktop") {
      const instanceId = flags.get("--desktop");
      if (!instanceId || flags.has("--headless"))
        throw new Error(
          "Desktop sessions require --desktop <instance-id> and cannot use --headless",
        );
      input.selection = {
        backend,
        hostId,
        instanceId,
        ...(flags.has("--tab") ? { tabId: flags.get("--tab") } : {}),
      };
    } else throw new Error("Select --backend desktop or --backend local");
  }
  if (method === "run") {
    if (flags.has("--script") === flags.has("--script-file"))
      throw new Error("Supply exactly one of --script or --script-file");
    if (flags.has("--script-file") !== flags.has("--script-host"))
      throw new Error(
        "--script-file requires explicit --script-host <host-id>",
      );
    input.script = flags.get("--script");
    input.timeoutMs = flags.has("--timeout-ms")
      ? Number(flags.get("--timeout-ms"))
      : 30_000;
  }
  if (method === "screenshot") input.page = flags.get("--page") ?? "main";
  return {
    method,
    input,
    scriptFile: flags.get("--script-file"),
    scriptHost: flags.get("--script-host"),
  };
}
