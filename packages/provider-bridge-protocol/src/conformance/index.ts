import { createBridgeDeltaEventCollector } from "../testing/bridge-delta-assembly.js";
import { ConformanceClient } from "./client.js";
import {
  runHandshakeScenario,
  runRpcHygieneScenarios,
  runSessionLifecycleScenarios,
  type ConformanceSessionFixture,
} from "./scenarios.js";
export {
  checkItemOpensBeforeDelta,
  checkPresentationIconsDeclared,
} from "./scenarios.js";
export {
  checkRecordedCellReplay,
  RECORDED_CONFORMANCE_CELLS,
  type RecordedCellReplay,
  type RecordedConformanceCell,
} from "./recorded.js";
import {
  reportPassed,
  type BridgeConformanceTransport,
  type ConformanceCheckResult,
  type ConformanceReport,
} from "./types.js";
export { CONFORMANCE_ASSEMBLED_EVENT_METHOD } from "./types.js";

export type {
  BridgeConformanceTransport,
  ConformanceCheckResult,
  ConformanceReport,
  ConformanceSessionFixture,
};
export { ConformanceClient } from "./client.js";

export interface RunBridgeConformanceOptions {
  transport: BridgeConformanceTransport;
  session: ConformanceSessionFixture;
  providerId: string;
  timeoutMs?: number;
}

export async function runBridgeConformance(
  options: RunBridgeConformanceOptions,
): Promise<ConformanceReport> {
  const collector = createBridgeDeltaEventCollector(options.providerId);
  const client = new ConformanceClient(
    options.transport,
    options.timeoutMs ?? 5_000,
    collector,
  );

  const results: ConformanceCheckResult[] = [];
  results.push(...(await runRpcHygieneScenarios(client)));
  const handshake = await runHandshakeScenario(client);
  results.push(...handshake.results);
  results.push(
    ...(await runSessionLifecycleScenarios({
      client,
      fixture: options.session,
      resolveProviderTurnId: (threadId, bbTurnId) =>
        collector.assembler.getProviderTurnId(threadId, bbTurnId),
      fork: handshake.capabilities?.fork ?? "none",
    })),
  );

  await options.transport.close?.();
  return { results, passed: reportPassed(results) };
}

export function formatConformanceReport(report: ConformanceReport): string {
  return report.results
    .map(
      (result) =>
        `${result.status.padEnd(7)} ${result.id}${
          result.detail === "" ? "" : ` — ${result.detail}`
        }`,
    )
    .join("\n");
}
