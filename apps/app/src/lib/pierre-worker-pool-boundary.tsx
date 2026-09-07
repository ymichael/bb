import { WorkerPoolContext } from "@pierre/diffs/react";
import { useContext, type ReactNode } from "react";
import { PierreWorkerPoolGateContext } from "./pierre-worker-pool-gate";

export function PierreWorkerPoolBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const gate = useContext(PierreWorkerPoolGateContext);
  if (gate === null) return children;
  return (
    <WorkerPoolContext.Provider value={gate.pool}>
      {children}
    </WorkerPoolContext.Provider>
  );
}
