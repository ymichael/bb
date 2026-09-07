import { rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createPluginProcessTempDir } from "@bb/process-utils";
import { readBoundedLines } from "./bridge-kit/bounded-line-reader.js";
import {
  createRecordingLineSplitter,
  getBridgeRecorder,
} from "./bridge-kit/bridge-recorder.js";
import {
  PROVIDER_BRIDGE_EXPORT_NAME,
  parseProviderBridgeEntry,
  type ProviderBridgeEntry,
} from "./bridge-kit/provider-bridge-entry.js";

const [bridgeModulePath, pluginId, dataDir] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (
  bridgeModulePath === undefined ||
  !isAbsolute(bridgeModulePath) ||
  pluginId === undefined ||
  pluginId === "" ||
  dataDir === undefined ||
  !isAbsolute(dataDir)
) {
  fail(
    "provider bridge bootstrap usage: <bridgeModulePath> <pluginId> <pluginDataDir> (absolute paths)",
  );
}

const tempDir = await createPluginProcessTempDir({
  pluginId,
  prefix: "bb-provider-bridge",
});

let removedTempDir = false;
function removeTempDir(): void {
  if (removedTempDir) return;
  removedTempDir = true;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}
process.once("exit", removeTempDir);

const recorder = getBridgeRecorder();
if (recorder !== null) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const outbound = createRecordingLineSplitter((line) =>
    recorder.recordRuntimeLine("bridge→runtime", line),
  );
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    outbound.push(chunk);
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  process.once("exit", () => recorder.close());
}

let entry: ProviderBridgeEntry;
try {
  const imported: unknown = await import(pathToFileURL(bridgeModulePath).href);
  const parsed = parseProviderBridgeEntry(
    typeof imported === "object" && imported !== null
      ? Reflect.get(imported, PROVIDER_BRIDGE_EXPORT_NAME)
      : undefined,
  );
  if (parsed.entry === null) {
    fail(
      `plugin "${pluginId}" cannot run as a provider bridge: its host artifact ${parsed.problem} (${bridgeModulePath})`,
    );
  }
  entry = parsed.entry;
} catch (error) {
  removeTempDir();
  fail(
    `plugin "${pluginId}" failed to load its provider bridge: ${error instanceof Error ? error.message : String(error)}`,
  );
}

entry.start?.({ pluginId, dataDir, tempDir });

if (entry.onSigterm) {
  process.once("SIGTERM", entry.onSigterm);
}
if (entry.onSigint) {
  process.once("SIGINT", entry.onSigint);
}

readBoundedLines({
  input: process.stdin,
  onLine:
    recorder === null
      ? entry.handleLine
      : (line) => {
          recorder.recordRuntimeLine("runtime→bridge", line);
          entry.handleLine(line);
        },
  onOverflow: (bytes) => {
    process.stderr.write(
      `Discarded an oversized JSON-RPC line from the runtime (${bytes} bytes).\n`,
    );
  },
  onClose: () => {
    removeTempDir();
    entry.onClose?.();
  },
});
