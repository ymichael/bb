import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = fileURLToPath(
  new URL("../../../e2e/scripts/ci-run-flows.sh", import.meta.url),
);

function runFixture({ cleanupFails }: { cleanupFails: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "bb-mobile-flow-runner-"));
  const bin = join(root, "bin");
  const artifacts = join(root, "artifacts");
  const trace = join(root, "trace.log");
  mkdirSync(bin);

  const maestro = join(bin, "maestro");
  writeFileSync(
    maestro,
    `#!/usr/bin/env bash
set -u
flow="\${!#}"
printf '%s\\n' "$flow" >> "$TRACE_FILE"
if [ "$flow" = "flows/fails.yaml" ]; then
  exit 1
fi
if [ "$flow" = "subflows/clear-open-confirmation.yaml" ] && [ "$CLEANUP_FAILS" = "1" ]; then
  exit 1
fi
exit 0
`,
  );
  chmodSync(maestro, 0o755);

  const xcrun = join(bin, "xcrun");
  writeFileSync(
    xcrun,
    `#!/usr/bin/env bash
set -u
printf 'xcrun %s\\n' "$*" >> "$TRACE_FILE"
exit 0
`,
  );
  chmodSync(xcrun, 0o755);

  const result = spawnSync(
    "bash",
    [runner, "simulator", artifacts, "fails", "passes"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TRACE_FILE: trace,
        CLEANUP_FAILS: cleanupFails ? "1" : "0",
      },
      killSignal: "SIGKILL",
      timeout: 5_000,
    },
  );

  return {
    dispose: () => rmSync(root, { force: true, recursive: true }),
    result,
    trace: readFileSync(trace, "utf8").trim().split("\n"),
  };
}

describe("ci-run-flows", () => {
  it("clears native confirmation state before continuing after a failed flow", () => {
    const fixture = runFixture({ cleanupFails: false });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.trace).toEqual([
        "flows/fails.yaml",
        expect.stringMatching(/^xcrun simctl io simulator screenshot /),
        "subflows/clear-open-confirmation.yaml",
        "flows/passes.yaml",
      ]);
      expect(fixture.result.stderr).toContain("Failed flows: fails");
    } finally {
      fixture.dispose();
    }
  });

  it("stops before a later flow when native-state cleanup cannot be verified", () => {
    const fixture = runFixture({ cleanupFails: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.trace).toEqual([
        "flows/fails.yaml",
        expect.stringMatching(/^xcrun simctl io simulator screenshot /),
        "subflows/clear-open-confirmation.yaml",
      ]);
      expect(fixture.result.stderr).toContain("stopping before the next flow");
    } finally {
      fixture.dispose();
    }
  });
});
