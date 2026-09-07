import type {
  ProviderNativeRoots,
  AvailableModel,
  ExtensionKind,
  JsonValue,
  PermissionMode,
  ProviderFork,
  ProviderInfo,
  ReasoningLevel,
} from "@bb/domain";
import { parseExtensionKind } from "@bb/domain";
import type {
  PluginProviderExtensionKindDeclaration,
  PluginProviderOptionsContext,
} from "@get-bb/plugin-sdk";
import { providerAlreadyRegisteredMessage } from "@get-bb/plugin-sdk/internal/host-policy";

export interface ProviderHealthCacheKey {
  hostId: string;
  providerId: string;
}

export interface ProviderServerCapabilities {
  reasoningLevels: readonly ReasoningLevel[];
  fork: ProviderFork;
  supportsManualCompaction: boolean;
}

export interface ProviderInstallRank {
  bundledIndex: number | null;
  installedAt: number;
}

export type ProviderExtensionKindSchemas = Readonly<
  Record<string, PluginProviderExtensionKindDeclaration>
>;

export interface ProviderRegistration {
  info: ProviderInfo;
  serverCapabilities: ProviderServerCapabilities;
  bridgeOptions: Readonly<Record<string, JsonValue>>;
  extensionKinds: ProviderExtensionKindSchemas;
  visibility: "always" | "installed";
  pluginId: string;
  fallbackModels: readonly AvailableModel[];
  envPassthrough: readonly string[];
  nativeSkillRoots: ProviderNativeRoots;
  nativeCommandRoots: ProviderNativeRoots;
  resolvesNativeRoots: boolean;
  deriveProviderOptions: (
    context: Omit<PluginProviderOptionsContext, "settings">,
  ) => Readonly<Record<string, JsonValue>>;
  icon?: { bytes: Uint8Array; contentType: string; hash: string };
  iconNames: ReadonlySet<string>;
}

const PROVIDER_INSTALLED_CACHE_TTL_MS = 5 * 60_000;

export interface ProviderRegistryService {
  list(): ProviderRegistration[];
  getUserDefaultProviderId(): string | null;
  get(providerId: string): ProviderRegistration | null;
  getRegistrationRevision(): number;
  lookupInstalled(key: ProviderHealthCacheKey): Promise<boolean> | undefined;
  rememberInstalled(
    key: ProviderHealthCacheKey,
    value: Promise<boolean>,
  ): void;
  forgetInstalledKey(key: ProviderHealthCacheKey): void;
  forgetInstalledProvider(providerId: string): void;
  forgetAllInstalled(): void;
  getServerCapabilities(providerId: string): ProviderServerCapabilities | null;
  getSupportedPermissionModes(
    providerId: string,
  ): readonly PermissionMode[] | null;
  supportsFork(providerId: string): boolean;
  supportsSessionRewind(providerId: string): boolean;
  supportsManualCompaction(providerId: string): boolean;
  getExtensionKindSchemas(
    kind: ExtensionKind,
  ): PluginProviderExtensionKindDeclaration | null;
  register(
    registration: ProviderRegistration & {
      installRank?: ProviderInstallRank;
    },
  ): { dispose(): void };
  whenProviderRegistered(providerId: string): Promise<void>;
  whenRegistrationsSettled(): Promise<void>;
  markRegistrationsSettled(): void;
}

const REGISTRATIONS_SETTLED_TIMEOUT_MS = 30_000;

interface ProviderRegistryDeps {
  readUserProviderPreferences?: () => {
    providerOrder: readonly string[];
    defaultProviderId: string | null;
  };
  deferRegistrationsSettled?: boolean;
}

export function createProviderRegistryService(
  deps: ProviderRegistryDeps = {},
): ProviderRegistryService {
  const pluginRegistrations = new Map<string, ProviderRegistration>();
  const registrationRanks = new Map<
    ProviderRegistration,
    { installRank: ProviderInstallRank | null; sequence: number }
  >();
  const providerRegistrationWaiters = new Map<string, Set<() => void>>();
  let registrationRevision = 0;
  const installedByHostId = new Map<
    string,
    Map<
      string,
      {
        registrationRevision: number;
        expiresAt: number;
        value: Promise<boolean>;
      }
    >
  >();
  let registrationSequence = 0;

  function compareInstallRank(
    a: ProviderRegistration,
    b: ProviderRegistration,
  ): number {
    const rankA = registrationRanks.get(a);
    const rankB = registrationRanks.get(b);
    const installA = rankA?.installRank ?? null;
    const installB = rankB?.installRank ?? null;
    if (installA !== null || installB !== null) {
      if (installA === null) return 1;
      if (installB === null) return -1;
      const bundledA = installA.bundledIndex;
      const bundledB = installB.bundledIndex;
      if (bundledA !== null || bundledB !== null) {
        if (bundledA === null) return 1;
        if (bundledB === null) return -1;
        if (bundledA !== bundledB) return bundledA - bundledB;
      } else if (installA.installedAt !== installB.installedAt) {
        return installA.installedAt - installB.installedAt;
      }
    }
    return (rankA?.sequence ?? 0) - (rankB?.sequence ?? 0);
  }
  let settle: (() => void) | null = null;
  const settled: Promise<void> =
    deps.deferRegistrationsSettled === true
      ? new Promise<void>((resolve) => {
          settle = resolve;
        })
      : Promise.resolve();

  function getRegistration(providerId: string): ProviderRegistration | null {
    return pluginRegistrations.get(providerId) ?? null;
  }

  function releaseProviderRegistrationWaiters(providerId: string): void {
    const waiters = providerRegistrationWaiters.get(providerId);
    if (waiters === undefined) return;
    providerRegistrationWaiters.delete(providerId);
    for (const resolve of waiters) resolve();
  }

  function releaseAllProviderRegistrationWaiters(): void {
    for (const waiters of providerRegistrationWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    providerRegistrationWaiters.clear();
  }

  async function waitUntilSettledOrTimeout(
    readiness: Promise<void>,
  ): Promise<void> {
    if (settle === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      readiness,
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REGISTRATIONS_SETTLED_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  return {
    list() {
      const entries = [...pluginRegistrations.values()].sort(
        compareInstallRank,
      );
      const userOrder =
        deps.readUserProviderPreferences?.().providerOrder ?? [];
      if (userOrder.length === 0) {
        return entries;
      }
      const pinned = (entry: ProviderRegistration): number => {
        const index = userOrder.indexOf(entry.info.id);
        return index === -1 ? userOrder.length : index;
      };
      return entries.sort((a, b) => pinned(a) - pinned(b));
    },

    getUserDefaultProviderId() {
      const preferred =
        deps.readUserProviderPreferences?.().defaultProviderId ?? null;
      if (preferred === null || !pluginRegistrations.has(preferred)) {
        return null;
      }
      return preferred;
    },

    get(providerId) {
      return getRegistration(providerId);
    },

    getRegistrationRevision() {
      return registrationRevision;
    },

    lookupInstalled(key) {
      const hostEntries = installedByHostId.get(key.hostId);
      if (hostEntries === undefined) return undefined;
      const entry = hostEntries.get(key.providerId);
      if (entry === undefined) return undefined;
      if (
        entry.registrationRevision !== registrationRevision ||
        entry.expiresAt <= Date.now()
      ) {
        hostEntries.delete(key.providerId);
        if (hostEntries.size === 0) installedByHostId.delete(key.hostId);
        return undefined;
      }
      return entry.value;
    },

    rememberInstalled(key, value) {
      let hostEntries = installedByHostId.get(key.hostId);
      if (hostEntries === undefined) {
        hostEntries = new Map();
        installedByHostId.set(key.hostId, hostEntries);
      }
      hostEntries.set(key.providerId, {
        registrationRevision,
        expiresAt: Date.now() + PROVIDER_INSTALLED_CACHE_TTL_MS,
        value,
      });
    },

    forgetInstalledKey(key) {
      const hostEntries = installedByHostId.get(key.hostId);
      if (hostEntries === undefined) return;
      hostEntries.delete(key.providerId);
      if (hostEntries.size === 0) installedByHostId.delete(key.hostId);
    },

    forgetInstalledProvider(providerId) {
      for (const [hostId, hostEntries] of installedByHostId) {
        hostEntries.delete(providerId);
        if (hostEntries.size === 0) installedByHostId.delete(hostId);
      }
    },

    forgetAllInstalled() {
      installedByHostId.clear();
    },

    getServerCapabilities(providerId) {
      const registration = getRegistration(providerId);
      if (registration) {
        return registration.serverCapabilities;
      }
      return null;
    },

    getSupportedPermissionModes(providerId) {
      const registration = getRegistration(providerId);
      if (registration) {
        return registration.info.capabilities.permissionModes;
      }
      return null;
    },

    supportsFork(providerId) {
      const registration = getRegistration(providerId);
      if (registration) {
        return registration.info.capabilities.supportsFork;
      }
      return false;
    },

    supportsSessionRewind(providerId) {
      const registration = getRegistration(providerId);
      if (registration) {
        return registration.info.capabilities.supportsSessionRewind;
      }
      return false;
    },

    supportsManualCompaction(providerId) {
      const registration = getRegistration(providerId);
      if (registration) {
        return registration.serverCapabilities.supportsManualCompaction;
      }
      return false;
    },

    getExtensionKindSchemas(kind) {
      const { pluginId, name } = parseExtensionKind(kind);
      for (const registration of pluginRegistrations.values()) {
        if (registration.pluginId !== pluginId) {
          continue;
        }
        const declared = registration.extensionKinds[name];
        if (declared !== undefined) {
          return declared;
        }
      }
      return null;
    },

    register(registration) {
      const providerId = registration.info.id;
      if (pluginRegistrations.has(providerId)) {
        throw new Error(providerAlreadyRegisteredMessage(providerId));
      }
      const { installRank, ...entry } = registration;
      pluginRegistrations.set(providerId, entry);
      registrationSequence += 1;
      registrationRanks.set(entry, {
        installRank: installRank ?? null,
        sequence: registrationSequence,
      });
      registrationRevision += 1;
      releaseProviderRegistrationWaiters(providerId);
      return {
        dispose() {
          if (pluginRegistrations.get(providerId) === entry) {
            pluginRegistrations.delete(providerId);
            registrationRanks.delete(entry);
            registrationRevision += 1;
          }
        },
      };
    },

    async whenProviderRegistered(providerId) {
      if (pluginRegistrations.has(providerId) || settle === null) {
        return;
      }
      const key = providerId;
      let release!: () => void;
      const registered = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiters = providerRegistrationWaiters.get(key) ?? new Set();
      waiters.add(release);
      providerRegistrationWaiters.set(key, waiters);
      try {
        await waitUntilSettledOrTimeout(registered);
      } finally {
        const currentWaiters = providerRegistrationWaiters.get(key);
        currentWaiters?.delete(release);
        if (currentWaiters?.size === 0) {
          providerRegistrationWaiters.delete(key);
        }
      }
    },

    async whenRegistrationsSettled() {
      await waitUntilSettledOrTimeout(settled);
    },

    markRegistrationsSettled() {
      settle?.();
      settle = null;
      releaseAllProviderRegistrationWaiters();
    },
  };
}
