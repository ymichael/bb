import {
  CodeView,
  File,
  FileDiff,
  GutterUtilitySlotStyles,
  MergeConflictSlotStyles,
  MultiFileDiff,
  PatchDiff,
  UnresolvedFile,
  Virtualizer,
  VirtualizerContext,
  WorkerPoolContext,
  noopRender,
  renderDiffChildren,
  renderFileChildren,
  templateRender,
  useFileDiffInstance,
  useFileInstance,
  useStableCallback,
  useVirtualizer,
} from "@pierre/diffs/react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ElementRef,
  type ReactNode,
} from "react";
import { PierreWorkerPoolBoundary } from "./pierre-worker-pool-boundary";
import {
  usePierreWorkerPool,
  useRequirePierreWorkerPool,
} from "./pierre-worker-pool-gate";
import { usePierreStrictModeRecoveryOptions } from "./pierre-strict-mode-recovery";

function gatePierreDiffComponent<
  P extends {
    options?: ComponentPropsWithoutRef<typeof FileDiff>["options"];
  },
>(Component: ComponentType<P>, name: string) {
  function PierreWorkerPoolGatedDiff(props: P) {
    const ready = useRequirePierreWorkerPool();
    const options = usePierreStrictModeRecoveryOptions(props.options);
    return (
      <PierreWorkerPoolBoundary>
        {ready ? <Component {...props} options={options} /> : null}
      </PierreWorkerPoolBoundary>
    );
  }
  PierreWorkerPoolGatedDiff.displayName = `PierreWorkerPoolGated(${name})`;
  return PierreWorkerPoolGatedDiff;
}

type CodeViewProps = ComponentPropsWithoutRef<typeof CodeView>;
type CodeViewHandle = ElementRef<typeof CodeView>;
type FileProps = ComponentPropsWithoutRef<typeof File>;
type UnresolvedFileProps = ComponentPropsWithoutRef<typeof UnresolvedFile>;

function GatedFile(props: FileProps) {
  const ready = useRequirePierreWorkerPool();
  const options = usePierreStrictModeRecoveryOptions(props.options);
  return (
    <PierreWorkerPoolBoundary>
      {ready ? <File {...props} options={options} /> : null}
    </PierreWorkerPoolBoundary>
  );
}

function GatedUnresolvedFile(props: UnresolvedFileProps) {
  const ready = useRequirePierreWorkerPool();
  const options = usePierreStrictModeRecoveryOptions(props.options);
  return (
    <PierreWorkerPoolBoundary>
      {ready ? <UnresolvedFile {...props} options={options} /> : null}
    </PierreWorkerPoolBoundary>
  );
}

const GatedCodeView = forwardRef<CodeViewHandle, CodeViewProps>(
  function PierreWorkerPoolGatedCodeView(props, ref) {
    const ready = useRequirePierreWorkerPool();
    return (
      <PierreWorkerPoolBoundary>
        {ready ? <CodeView {...props} ref={ref} /> : null}
      </PierreWorkerPoolBoundary>
    );
  },
);

function HostWorkerPoolContextProvider({ children }: { children: ReactNode }) {
  return <PierreWorkerPoolBoundary>{children}</PierreWorkerPoolBoundary>;
}

export function createGatedPierreDiffsReact(): Record<string, unknown> {
  return {
    CodeView: GatedCodeView,
    File: GatedFile,
    FileDiff: gatePierreDiffComponent(FileDiff, "FileDiff"),
    GutterUtilitySlotStyles,
    MergeConflictSlotStyles,
    MultiFileDiff: gatePierreDiffComponent(MultiFileDiff, "MultiFileDiff"),
    PatchDiff: gatePierreDiffComponent(PatchDiff, "PatchDiff"),
    UnresolvedFile: GatedUnresolvedFile,
    Virtualizer,
    VirtualizerContext,
    WorkerPoolContext,
    WorkerPoolContextProvider: HostWorkerPoolContextProvider,
    noopRender,
    renderDiffChildren,
    renderFileChildren,
    templateRender,
    useFileDiffInstance,
    useFileInstance,
    useStableCallback,
    useVirtualizer,
    useWorkerPool: usePierreWorkerPool,
  };
}
