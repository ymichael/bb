import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { createContext, useContext, useEffect } from "react";

export interface PierreWorkerPoolGate {
  ready: boolean;
  pool: WorkerPoolManager | undefined;
  request: () => void;
}

export const PierreWorkerPoolGateContext =
  createContext<PierreWorkerPoolGate | null>(null);

export function useRequirePierreWorkerPool(): boolean {
  const gate = useContext(PierreWorkerPoolGateContext);
  const request = gate?.request;
  useEffect(() => {
    request?.();
  }, [request]);
  return gate === null ? true : gate.ready;
}

export function usePierreWorkerPool(): WorkerPoolManager | undefined {
  return useContext(PierreWorkerPoolGateContext)?.pool;
}
