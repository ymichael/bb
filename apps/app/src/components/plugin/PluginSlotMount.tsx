import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pill } from "@bb/shared-ui/pill";
import { useRouteAnchorDelegate } from "@/components/ui/app-route-anchor";
import { usePluginCss } from "@/lib/plugin-css";
import {
  PluginContext,
  PluginSlotOwnershipContext,
  type PluginSlotOwnershipRegistry,
} from "./plugin-context";

const crashedSlotInstances = new Set<string>();
const ownedStateReleasesBySlotInstance = new Map<
  string,
  Map<symbol, () => void>
>();

function registerSlotOwnedState(
  instanceKey: string,
  owner: symbol,
  release: () => void,
): void {
  let releases = ownedStateReleasesBySlotInstance.get(instanceKey);
  if (!releases) {
    releases = new Map();
    ownedStateReleasesBySlotInstance.set(instanceKey, releases);
  }
  releases.set(owner, release);
}

function unregisterSlotOwnedState(instanceKey: string, owner: symbol): void {
  const releases = ownedStateReleasesBySlotInstance.get(instanceKey);
  releases?.delete(owner);
  if (releases?.size === 0) {
    ownedStateReleasesBySlotInstance.delete(instanceKey);
  }
}

function releaseSlotInstanceOwnedState(instanceKey: string): void {
  const releases = [
    ...(ownedStateReleasesBySlotInstance.get(instanceKey)?.values() ?? []),
  ];
  ownedStateReleasesBySlotInstance.delete(instanceKey);
  for (const release of releases) release();
}

function pluginSlotInstanceKey(
  pluginId: string,
  slotKind: string,
  slotId: string,
  instanceId?: string,
): string {
  const base = `${pluginId}/${slotKind}/${slotId}`;
  return instanceId === undefined ? base : `${base}/${instanceId}`;
}

export function resetCrashedPluginSlots(pluginId: string): void {
  const prefix = `${pluginId}/`;
  for (const key of [...crashedSlotInstances]) {
    if (key.startsWith(prefix)) crashedSlotInstances.delete(key);
  }
}

export function resetAllCrashedPluginSlotsForTest(): void {
  crashedSlotInstances.clear();
}

function CrashedPluginChip({ pluginId }: { pluginId: string }) {
  return (
    <Pill variant="outline" className="text-muted-foreground">
      plugin {pluginId} crashed
    </Pill>
  );
}

interface PluginSlotBoundaryProps {
  pluginId: string;
  instanceKey: string;
  children: ReactNode;
  fallback?: ReactNode;
  onCrash?: (pluginId: string) => void;
}

interface PluginSlotBoundaryState {
  crashed: boolean;
}

class PluginSlotBoundary extends Component<
  PluginSlotBoundaryProps,
  PluginSlotBoundaryState
> {
  private readonly ownedStateReleases = new Map<symbol, () => void>();

  private readonly ownershipRegistry: PluginSlotOwnershipRegistry = {
    register: (owner, release) => {
      this.ownedStateReleases.set(owner, release);
      registerSlotOwnedState(this.props.instanceKey, owner, release);
    },
    unregister: (owner) => {
      this.ownedStateReleases.delete(owner);
      unregisterSlotOwnedState(this.props.instanceKey, owner);
    },
  };

  constructor(props: PluginSlotBoundaryProps) {
    super(props);
    this.state = { crashed: crashedSlotInstances.has(props.instanceKey) };
  }

  static getDerivedStateFromError(): PluginSlotBoundaryState {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    releaseSlotInstanceOwnedState(this.props.instanceKey);
    this.ownedStateReleases.clear();
    crashedSlotInstances.add(this.props.instanceKey);
    console.warn(
      `[plugin:${this.props.pluginId}] slot "${this.props.instanceKey}" crashed and is disabled for this session: ${error.message}`,
      info.componentStack,
    );
    try {
      this.props.onCrash?.(this.props.pluginId);
    } catch (notifyError) {
      console.warn(
        `[plugin:${this.props.pluginId}] slot crash notifier failed`,
        notifyError,
      );
    }
  }

  override componentWillUnmount(): void {
    this.releaseOwnedState();
  }

  private releaseOwnedState(): void {
    const entries = [...this.ownedStateReleases.entries()];
    this.ownedStateReleases.clear();
    for (const [owner, release] of entries) {
      unregisterSlotOwnedState(this.props.instanceKey, owner);
      release();
    }
  }

  override render(): ReactNode {
    if (
      this.state.crashed ||
      crashedSlotInstances.has(this.props.instanceKey)
    ) {
      return this.props.fallback === undefined ? (
        <CrashedPluginChip pluginId={this.props.pluginId} />
      ) : (
        this.props.fallback
      );
    }
    return (
      <PluginSlotOwnershipContext.Provider value={this.ownershipRegistry}>
        {this.props.children}
      </PluginSlotOwnershipContext.Provider>
    );
  }
}

interface PluginSlotMountProps {
  pluginId: string;
  slotKind: string;
  slotId: string;
  children: ReactNode;
  crashFallback?: ReactNode;
  instanceId?: string;
  onCrash?: (pluginId: string) => void;
}

export function PluginSlotMount({
  pluginId,
  slotKind,
  slotId,
  children,
  crashFallback,
  instanceId,
  onCrash,
}: PluginSlotMountProps) {
  const onRouteAnchorClick = useRouteAnchorDelegate();
  usePluginCss(pluginId);
  return (
    <PluginContext.Provider value={pluginId}>
      <PluginSlotBoundary
        pluginId={pluginId}
        instanceKey={pluginSlotInstanceKey(
          pluginId,
          slotKind,
          slotId,
          instanceId,
        )}
        fallback={crashFallback}
        {...(onCrash ? { onCrash } : {})}
      >
        <div
          data-bb-plugin-root=""
          data-bb-plugin={pluginId}
          className="contents"
          onClick={onRouteAnchorClick}
        >
          {children}
        </div>
      </PluginSlotBoundary>
    </PluginContext.Provider>
  );
}
