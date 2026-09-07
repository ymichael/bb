import { randomUUID } from "node:crypto";
import type {
  BbDesktopBrowserControlState,
  BbDesktopBrowserTarget,
} from "@bb/desktop-contract";
import type {
  DesktopBrowserChanged,
  DesktopBrowserCommand,
  DesktopBrowserInstance,
  DesktopBrowserLease,
  DesktopBrowserResult,
  DesktopBrowserTab,
} from "@bb/host-daemon-contract";
import {
  createDesktopBrowserCdpBridge,
  type DesktopBrowserCdpAdapter,
} from "./desktop-browser-cdp.js";
import { createDesktopBrowserCdpAdapter } from "./desktop-browser-cdp-adapter.js";
import {
  BB_DESKTOP_BROWSER_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_REVEAL_CHANNEL,
} from "./desktop-browser-ipc.js";
import type {
  DesktopBrowserHostWindow,
  DesktopBrowserNativeTab,
  DesktopBrowserViewManager,
} from "./desktop-browser-view.js";

interface BrokerWindow extends DesktopBrowserHostWindow {
  focus(): void;
  show(): void;
  restore(): void;
  isMinimized(): boolean;
}

interface InstanceEntry {
  window: BrokerWindow;
  descriptor: DesktopBrowserInstance;
  threads: Set<string>;
}

interface ControlLease {
  instance: InstanceEntry;
  threadId: string;
  metadata: DesktopBrowserLease;
  tabs: Map<string, string>;
  timer: ReturnType<typeof setTimeout>;
  bridge: Awaited<ReturnType<typeof createDesktopBrowserCdpBridge>> | null;
  connection: { wsEndpoint: string; expiresAt: number } | null;
}

export function createDesktopBrowserBroker(args: {
  manager: DesktopBrowserViewManager;
  product: string;
}) {
  const instances = new Map<string, InstanceEntry>();
  const leases = new Map<string, ControlLease>();
  const listeners = new Set<(event: DesktopBrowserChanged) => void>();
  const registryListeners = new Set<() => void>();
  const snapshots = new Map<string, string>();
  let hostId: string | null = null;

  function instanceForWindow(webContentsId: number): InstanceEntry | undefined {
    return [...instances.values()].find(
      (entry) => entry.window.webContents.id === webContentsId,
    );
  }

  function controlFor(
    instance: InstanceEntry,
    tabId: string,
  ): ControlLease | undefined {
    return [...leases.values()].find(
      (lease) => lease.instance === instance && lease.tabs.has(tabId),
    );
  }

  function tabsFor(
    instance: InstanceEntry,
    threadId: string,
  ): DesktopBrowserNativeTab[] {
    return args.manager.listTabs({
      hostWebContentsId: instance.window.webContents.id,
      threadId,
    });
  }

  function wireTab(
    instance: InstanceEntry,
    tab: DesktopBrowserNativeTab,
  ): DesktopBrowserTab {
    return {
      tabId: tab.tabId,
      threadId: tab.threadId,
      url: tab.url,
      title: tab.title ?? "",
      profile: tab.profile,
      presentation: tab.presentation,
      control: controlFor(instance, tab.tabId)?.metadata ?? null,
    };
  }

  function publish(instance: InstanceEntry, threadId: string): void {
    instance.threads.add(threadId);
    const tabs = tabsFor(instance, threadId).map((tab) =>
      wireTab(instance, tab),
    );
    const event: DesktopBrowserChanged = {
      type: "desktop-browser.changed",
      instanceId: instance.descriptor.instanceId,
      generation: instance.descriptor.generation,
      threadId,
      tabs,
    };
    const key = `${instance.descriptor.instanceId}:${threadId}`;
    const serialized = JSON.stringify(event);
    if (snapshots.get(key) === serialized) return;
    snapshots.set(key, serialized);
    for (const listener of listeners) listener(event);
    if (
      instance.window.isDestroyed() ||
      instance.window.webContents.isDestroyed()
    )
      return;
    for (const tab of tabs) {
      instance.window.webContents.send(BB_DESKTOP_BROWSER_CONTROL_CHANNEL, {
        tabId: tab.tabId,
        threadId,
        control: tab.control,
      });
    }
  }

  function revoke(lease: ControlLease): void {
    leases.delete(lease.metadata.leaseId);
    clearTimeout(lease.timer);
    void lease.bridge?.close().catch(() => undefined);
    publish(lease.instance, lease.threadId);
  }

  function changed(): void {
    for (const lease of [...leases.values()]) {
      const tabs = tabsFor(lease.instance, lease.threadId);
      if (
        [...lease.tabs].some(
          ([id, generation]) =>
            !tabs.some(
              (tab) => tab.tabId === id && tab.generation === generation,
            ),
        )
      )
        revoke(lease);
    }
    for (const instance of instances.values()) {
      for (const tab of args.manager.listTabs({
        hostWebContentsId: instance.window.webContents.id,
        threadId: null,
      }))
        instance.threads.add(tab.threadId);
      for (const threadId of instance.threads) publish(instance, threadId);
    }
  }
  const unsubscribeManager = args.manager.subscribeAutomationTabs(changed);

  function requireInstance(target: {
    instanceId: string;
    generation: string;
  }): InstanceEntry {
    const instance = instances.get(target.instanceId);
    if (
      !instance ||
      instance.descriptor.generation !== target.generation ||
      instance.window.isDestroyed()
    )
      throw new Error("Desktop instance is unavailable or has reconnected");
    return instance;
  }

  function requireTab(
    instance: InstanceEntry,
    threadId: string,
    tabId: string,
  ): DesktopBrowserNativeTab {
    const tab = tabsFor(instance, threadId).find((tab) => tab.tabId === tabId);
    if (!tab) throw new Error("Browser tab is outside the requested thread");
    return tab;
  }

  function reveal(
    instance: InstanceEntry,
    threadId: string,
    tabId: string,
  ): void {
    requireTab(instance, threadId, tabId);
    if (hostId === null)
      throw new Error("Desktop is not connected to its host daemon");
    if (instance.window.isMinimized()) instance.window.restore();
    instance.window.show();
    instance.window.focus();
    instance.window.webContents.send(BB_DESKTOP_BROWSER_REVEAL_CHANNEL, {
      tabId,
      threadId,
      desktopTarget: {
        hostId,
        instanceId: instance.descriptor.instanceId,
        generation: instance.descriptor.generation,
      },
    });
  }

  async function openConnection(lease: ControlLease) {
    if (lease.connection !== null) return lease.connection;
    const scope = {
      hostWebContentsId: lease.instance.window.webContents.id,
      threadId: lease.threadId,
    };
    const ensureLease = () => {
      if (
        leases.get(lease.metadata.leaseId) !== lease ||
        lease.metadata.expiresAt <= Date.now()
      )
        throw new Error("Browser control lease has expired");
    };
    const nativeAdapter = createDesktopBrowserCdpAdapter({
      manager: args.manager,
      async createTab(_scope, url, signal) {
        signal.throwIfAborted();
        ensureLease();
        const firstId = lease.tabs.keys().next().value;
        if (firstId === undefined)
          throw new Error("Browser lease has no pages");
        const profile = requireTab(
          lease.instance,
          lease.threadId,
          firstId,
        ).profile;
        if (profile.kind !== "automation")
          throw new Error("Create automation pages in a dedicated profile");
        if (lease.tabs.size >= 100)
          throw new Error("Browser lease tab limit reached");
        const tab = args.manager.createTab({
          hostWindow: lease.instance.window,
          threadId: lease.threadId,
          tabId: `browser:${randomUUID()}:none`,
          url,
          profile,
          viewport: { width: 1280, height: 720 },
        });
        lease.tabs.set(tab.tabId, tab.generation);
        publish(lease.instance, lease.threadId);
        reveal(lease.instance, lease.threadId, tab.tabId);
        return tab.tabId;
      },
      async activateTab(_scope, tabId, signal) {
        signal.throwIfAborted();
        ensureLease();
        if (!lease.tabs.has(tabId))
          throw new Error("Tab is outside this lease");
        reveal(lease.instance, lease.threadId, tabId);
      },
      async closeTab(_scope, tabId, signal) {
        signal.throwIfAborted();
        ensureLease();
        const generation = lease.tabs.get(tabId);
        if (generation === undefined)
          throw new Error("Tab is outside this lease");
        lease.tabs.delete(tabId);
        args.manager.closeTab({ ...scope, tabId, generation });
      },
    });
    const adapter: DesktopBrowserCdpAdapter = {
      ...nativeAdapter,
      listTabs(requestedScope) {
        if (leases.get(lease.metadata.leaseId) !== lease) return [];
        return nativeAdapter
          .listTabs(requestedScope)
          .filter((tab) => lease.tabs.has(tab.tabId));
      },
    };
    const bridge = await createDesktopBrowserCdpBridge({
      adapter,
      product: args.product,
    });
    try {
      ensureLease();
      const grant = bridge.grant(scope, lease.metadata.expiresAt);
      lease.bridge = bridge;
      lease.connection = {
        wsEndpoint: grant.endpoint,
        expiresAt: grant.expiresAt,
      };
      return lease.connection;
    } catch (error) {
      await bridge.close();
      throw error;
    }
  }

  return {
    registerWindow(window: BrokerWindow) {
      if (instanceForWindow(window.webContents.id)) return;
      const descriptor = {
        instanceId: randomUUID(),
        generation: randomUUID(),
        label: `BB window ${window.webContents.id}`,
      };
      instances.set(descriptor.instanceId, {
        window,
        descriptor,
        threads: new Set(),
      });
      for (const listener of registryListeners) listener();
      changed();
    },
    releaseWindow(webContentsId: number) {
      const instance = instanceForWindow(webContentsId);
      if (!instance) return;
      for (const lease of [...leases.values()])
        if (lease.instance === instance) revoke(lease);
      instances.delete(instance.descriptor.instanceId);
      for (const listener of registryListeners) listener();
    },
    listInstances(): DesktopBrowserInstance[] {
      return [...instances.values()].map((entry) => ({ ...entry.descriptor }));
    },
    setHostId(value: string | null) {
      hostId = value;
      snapshots.clear();
      if (value === null) {
        for (const lease of [...leases.values()]) revoke(lease);
        for (const instance of instances.values())
          instance.descriptor.generation = randomUUID();
      } else changed();
    },
    resetServer() {
      hostId = null;
      for (const lease of [...leases.values()]) revoke(lease);
      args.manager.destroyAll();
      for (const instance of instances.values()) {
        instance.threads.clear();
        instance.descriptor.generation = randomUUID();
      }
      snapshots.clear();
    },
    getTarget(webContentsId: number): BbDesktopBrowserTarget | null {
      const instance = instanceForWindow(webContentsId);
      return instance && hostId !== null
        ? {
            hostId,
            instanceId: instance.descriptor.instanceId,
            generation: instance.descriptor.generation,
          }
        : null;
    },
    getControl(
      webContentsId: number,
      tabId: string,
    ): BbDesktopBrowserControlState | null {
      const instance = instanceForWindow(webContentsId);
      const tab =
        instance &&
        args.manager
          .listTabs({ hostWebContentsId: webContentsId, threadId: null })
          .find((tab) => tab.tabId === tabId);
      return instance && tab
        ? {
            threadId: tab.threadId,
            tabId,
            control: controlFor(instance, tabId)?.metadata ?? null,
          }
        : null;
    },
    takeOver(webContentsId: number, tabId: string) {
      const instance = instanceForWindow(webContentsId);
      const lease = instance && controlFor(instance, tabId);
      if (lease) revoke(lease);
    },
    subscribe(listener: (event: DesktopBrowserChanged) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeInstances(listener: () => void) {
      registryListeners.add(listener);
      return () => {
        registryListeners.delete(listener);
      };
    },
    async execute(
      command: DesktopBrowserCommand,
    ): Promise<DesktopBrowserResult> {
      if (command.type === "desktop.browser.list_instances")
        return { instances: this.listInstances() };
      const instance = requireInstance(command);
      const scope = {
        hostWebContentsId: instance.window.webContents.id,
        threadId: command.threadId,
      };
      switch (command.type) {
        case "desktop.browser.list_tabs":
          return {
            tabs: tabsFor(instance, command.threadId).map((tab) =>
              wireTab(instance, tab),
            ),
          };
        case "desktop.browser.create_tab": {
          const tab = args.manager.createTab({
            hostWindow: instance.window,
            ...command,
            viewport: { width: 1280, height: 720 },
          });
          if (command.presentation === "reveal")
            reveal(instance, command.threadId, tab.tabId);
          return { tab: wireTab(instance, tab) };
        }
        case "desktop.browser.reveal_tab":
          reveal(instance, command.threadId, command.tabId);
          return { ok: true };
        case "desktop.browser.close_tab": {
          const tab = requireTab(instance, command.threadId, command.tabId);
          args.manager.closeTab({
            ...scope,
            tabId: tab.tabId,
            generation: tab.generation,
          });
          return { ok: true };
        }
        case "desktop.browser.capture_tab": {
          const tab = requireTab(instance, command.threadId, command.tabId);
          const capture = await args.manager.captureTab({
            ...scope,
            tabId: tab.tabId,
            generation: tab.generation,
            maxWidth: 1920,
            maxHeight: 1080,
            quality: 80,
          });
          return {
            mimeType: "image/jpeg",
            base64: capture.data.toString("base64"),
            width: capture.width,
            height: capture.height,
          };
        }
        case "desktop.browser.acquire_control": {
          if (leases.size >= 100 || leases.has(command.leaseId))
            throw new Error("Browser lease limit or duplicate lease");
          if (
            command.expiresAt <= Date.now() ||
            command.expiresAt - Date.now() > 3_600_000
          )
            throw new Error("Browser lease must expire within one hour");
          const tabs = new Map<string, string>();
          for (const tabId of command.tabIds) {
            const tab = requireTab(instance, command.threadId, tabId);
            if (controlFor(instance, tabId))
              throw new Error("Browser tab already has a controller");
            tabs.set(tabId, tab.generation);
          }
          const metadata = {
            leaseId: command.leaseId,
            controllerLabel: command.controllerLabel,
            expiresAt: command.expiresAt,
          };
          const timer = setTimeout(() => {
            const lease = leases.get(command.leaseId);
            if (lease) revoke(lease);
          }, command.expiresAt - Date.now());
          timer.unref();
          leases.set(command.leaseId, {
            instance,
            threadId: command.threadId,
            metadata,
            tabs,
            timer,
            bridge: null,
            connection: null,
          });
          publish(instance, command.threadId);
          return { lease: metadata };
        }
        case "desktop.browser.open_connection":
        case "desktop.browser.release_control": {
          const lease = leases.get(command.leaseId);
          if (
            !lease ||
            lease.instance !== instance ||
            lease.threadId !== command.threadId
          )
            throw new Error("Browser lease is unavailable");
          if (command.type === "desktop.browser.release_control") {
            revoke(lease);
            return { ok: true };
          }
          if (
            command.tabIds.length !== lease.tabs.size ||
            command.tabIds.some((id) => !lease.tabs.has(id))
          )
            throw new Error("Connection tab set does not match the lease");
          return openConnection(lease);
        }
      }
    },
    dispose() {
      unsubscribeManager();
      for (const lease of [...leases.values()]) revoke(lease);
      listeners.clear();
      registryListeners.clear();
      instances.clear();
    },
  };
}

export type DesktopBrowserBroker = ReturnType<
  typeof createDesktopBrowserBroker
>;
