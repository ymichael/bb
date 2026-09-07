import type { PostRenderPhase } from "@pierre/diffs";
import { useMemo } from "react";

interface RerenderablePierreInstance {
  rerender(): void;
}

interface PierrePostRenderOptions<
  TInstance extends RerenderablePierreInstance,
> {
  onPostRender?(
    node: HTMLElement,
    instance: TInstance,
    phase: PostRenderPhase,
  ): unknown;
}

export function usePierreStrictModeRecoveryOptions<
  TInstance extends RerenderablePierreInstance,
  TOptions extends PierrePostRenderOptions<TInstance>,
>(options: TOptions | undefined) {
  return useMemo(() => {
    if (!import.meta.env.DEV) return options;

    const onPostRender = options?.onPostRender;
    return {
      ...options,
      onPostRender(
        node: HTMLElement,
        instance: TInstance,
        phase: PostRenderPhase,
      ) {
        onPostRender?.(node, instance, phase);
        if (phase === "mount") {
          queueMicrotask(() => instance.rerender());
        }
      },
    };
  }, [options]);
}
