export interface BridgeConformanceTransport {
  send(line: string): void;
  takeMessages(): unknown[];
  close?(): Promise<void> | void;
}

export const CONFORMANCE_ASSEMBLED_EVENT_METHOD = "conformance/assembledEvent";

export type ConformanceStatus = "pass" | "fail" | "skipped";

export interface ConformanceCheckResult {
  id: string;
  title: string;
  status: ConformanceStatus;
  detail: string;
}

export interface ConformanceReport {
  results: ConformanceCheckResult[];
  passed: boolean;
}

export function reportPassed(results: ConformanceCheckResult[]): boolean {
  return results.every((result) => result.status === "pass");
}
