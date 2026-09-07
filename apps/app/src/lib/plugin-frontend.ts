import * as react from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as radixAlertDialog from "@radix-ui/react-alert-dialog";
import * as radixContextMenu from "@radix-ui/react-context-menu";
import * as radixDialog from "@radix-ui/react-dialog";
import * as radixDropdownMenu from "@radix-ui/react-dropdown-menu";
import * as radixHoverCard from "@radix-ui/react-hover-card";
import * as radixMenubar from "@radix-ui/react-menubar";
import * as radixNavigationMenu from "@radix-ui/react-navigation-menu";
import * as radixPopover from "@radix-ui/react-popover";
import * as radixSelect from "@radix-ui/react-select";
import * as radixTooltip from "@radix-ui/react-tooltip";
import * as sonner from "sonner";
import * as vaul from "vaul";
import * as pierreDiffs from "@pierre/diffs";
import * as clsx from "clsx";
import * as tailwindMerge from "tailwind-merge";
import * as classVarianceAuthority from "class-variance-authority";
import * as sharedUiIcon from "@bb/shared-ui/icon";
import { createDebouncedCallbackScheduler } from "@bb/domain";
import { BbHttpError } from "@bb/sdk/browser";
import type { QueryClient } from "@tanstack/react-query";
import { markEnabledPluginListStale } from "@/hooks/cache-owners/plugin-cache-owner";
import { pluginListQueryOptions } from "@/hooks/queries/plugin-settings-queries";
import { createRecordingToast } from "@/lib/notifications/plugin-toast-recording";
import { appQueryClient } from "./app-query-client";
import type {
  PluginContentScriptDisposer,
  PluginContentScriptRegistration,
  PluginSdkApp,
} from "@get-bb/plugin-sdk";
import { normalizePluginThreadRowStatus } from "@get-bb/plugin-sdk/internal/composer-customization-validation";
import { resetCrashedPluginSlots } from "@/components/plugin/PluginSlotMount";
import { runWithPluginDomIsolationAsync } from "./foreign-dom-mutation-guard";
import { applyPluginCss, retainPluginCss } from "./plugin-css";
import {
  collectPluginAppRegistrations,
  isPluginAppDefinition,
} from "./plugin-app-definition";
import { setPluginLogoUrls, type PluginLogoUrls } from "./plugin-logos";
import { createGatedPierreDiffsReact } from "./plugin-pierre-diffs-react";
import { getPluginPanelRoutePluginId } from "./route-paths";
import { pluginSdkAppImplementation } from "./plugin-sdk-app-impl";
import {
  beginPluginSlotBatch,
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "./plugin-slots";
import {
  clearPluginThreadRowStatuses,
  clearPluginThreadRowStatusesByOwner,
  setPluginThreadRowStatus,
} from "./plugin-thread-row-status";

interface PluginFrontendBundle {
  jsUrl: string;
  cssUrl: string | null;
  jsBytes: number;
  hash: string;
  sdkMajor: number;
  sdkVersion: string;
  compatible: boolean;
}

export interface PluginFrontendCandidate {
  pluginId: string;
  bundle: PluginFrontendBundle;
}

type PluginFrontendRecord =
  | {
      pluginId: string;
      status: "loaded";
      module: Record<string, unknown>;
    }
  | { pluginId: string; status: "failed"; error: string }
  | {
      pluginId: string;
      status: "needs-update";
      sdkMajor: number;
      sdkVersion: string;
    };

interface PluginFrontendFailure {
  phase: "load" | "setup" | "mount" | "dispose";
  message: string;
  scriptId: string | null;
}

interface PluginFrontendActiveGenerationDiagnostic {
  generation: number;
  hash: string;
  contentScriptIds: readonly string[];
}

export type PluginFrontendDiagnostic =
  | {
      pluginId: string;
      status: "active";
      active: PluginFrontendActiveGenerationDiagnostic;
      lastFailure: PluginFrontendFailure | null;
    }
  | {
      pluginId: string;
      status: "failed";
      active: PluginFrontendActiveGenerationDiagnostic | null;
      lastFailure: PluginFrontendFailure;
    }
  | {
      pluginId: string;
      status: "needs-update";
      active: PluginFrontendActiveGenerationDiagnostic | null;
      sdkMajor: number;
      sdkVersion: string;
      lastFailure: null;
    };

interface PluginFrontendLoaderDeps {
  importModule: (url: string) => Promise<unknown>;
  injectCss: (pluginId: string, url: string) => void;
  warn: (message: string) => void;
}

export async function loadPluginFrontends(
  candidates: readonly PluginFrontendCandidate[],
  deps: PluginFrontendLoaderDeps,
): Promise<Map<string, PluginFrontendRecord>> {
  const records = new Map<string, PluginFrontendRecord>();
  await Promise.all(
    candidates.map(async (candidate) => {
      records.set(candidate.pluginId, await loadOneBundle(candidate, deps));
    }),
  );
  return records;
}

async function loadOneBundle(
  { pluginId, bundle }: PluginFrontendCandidate,
  deps: PluginFrontendLoaderDeps,
): Promise<PluginFrontendRecord> {
  if (!bundle.compatible) {
    deps.warn(
      `[plugin:${pluginId}] frontend bundle was built against plugin SDK ${bundle.sdkVersion} (incompatible major) — skipping until the plugin is updated`,
    );
    return {
      pluginId,
      status: "needs-update",
      sdkMajor: bundle.sdkMajor,
      sdkVersion: bundle.sdkVersion,
    };
  }
  try {
    if (bundle.cssUrl !== null) deps.injectCss(pluginId, bundle.cssUrl);
    const mod = await deps.importModule(bundle.jsUrl);
    if (typeof mod !== "object" || mod === null) {
      throw new Error("bundle did not evaluate to a module namespace");
    }
    return {
      pluginId,
      status: "loaded",
      module: mod as Record<string, unknown>,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warn(
      `[plugin:${pluginId}] frontend bundle failed to load: ${message}`,
    );
    return { pluginId, status: "failed", error: message };
  }
}

interface BbPluginRuntime {
  react: unknown;
  reactDom: unknown;
  reactDomClient: unknown;
  jsxRuntime: unknown;
  jsxDevRuntime: unknown;
  pluginSdkApp: PluginSdkApp;
  radixAlertDialog: unknown;
  radixContextMenu: unknown;
  radixDialog: unknown;
  radixDropdownMenu: unknown;
  radixHoverCard: unknown;
  radixMenubar: unknown;
  radixNavigationMenu: unknown;
  radixPopover: unknown;
  radixSelect: unknown;
  radixTooltip: unknown;
  sonner: unknown;
  vaul: unknown;
  pierreDiffs: unknown;
  pierreDiffsReact: unknown;
  clsx: unknown;
  tailwindMerge: unknown;
  classVarianceAuthority: unknown;
  sharedUiIcon: unknown;
}

type RuntimeHost = typeof globalThis & { __bbPluginRuntime?: BbPluginRuntime };

export function installPluginRuntime(): void {
  const host = globalThis as RuntimeHost;
  if (host.__bbPluginRuntime !== undefined) return;
  host.__bbPluginRuntime = {
    react,
    reactDom,
    reactDomClient,
    jsxRuntime,
    jsxDevRuntime,
    pluginSdkApp: pluginSdkAppImplementation,
    radixAlertDialog,
    radixContextMenu,
    radixDialog,
    radixDropdownMenu,
    radixHoverCard,
    radixMenubar,
    radixNavigationMenu,
    radixPopover,
    radixSelect,
    radixTooltip,
    sonner: { ...sonner, toast: createRecordingToast(sonner.toast) },
    vaul,
    pierreDiffs,
    pierreDiffsReact: createGatedPierreDiffsReact(),
    clsx,
    tailwindMerge,
    classVarianceAuthority,
    sharedUiIcon,
  };
}

export async function fetchFrontendCandidates(
  queryClient: QueryClient = appQueryClient,
): Promise<PluginFrontendCandidate[]> {
  let plugins;
  try {
    plugins = await queryClient.fetchQuery(
      pluginListQueryOptions({ enabled: true }),
    );
  } catch (error) {
    if (
      error instanceof BbHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      setPluginLogoUrls(new Map());
      return [];
    }
    throw error;
  }
  const candidates: PluginFrontendCandidate[] = [];
  const logoUrls = new Map<string, PluginLogoUrls>();
  for (const plugin of plugins) {
    logoUrls.set(plugin.id, {
      displayName: plugin.name,
      icon: plugin.icon,
      compactIconUrl: plugin.iconUrl,
      logoUrl: plugin.logoUrl,
      logoDarkUrl: plugin.logoDarkUrl,
      icons: new Map(Object.entries(plugin.icons)),
    });
    if (
      plugin.status !== "running" &&
      plugin.status !== "needs-configuration" &&
      plugin.status !== "degraded"
    ) {
      continue;
    }
    const bundle = plugin.app.bundle;
    if (bundle === null) continue;
    candidates.push({ pluginId: plugin.id, bundle });
  }
  setPluginLogoUrls(logoUrls);
  return candidates;
}

export { applyPluginCss } from "./plugin-css";

export const PLUGIN_FRONTEND_LOAD_CONCURRENCY = 3;

export function orderPluginFrontendCandidates(
  candidates: readonly PluginFrontendCandidate[],
  routePluginId: string | null,
): PluginFrontendCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.pluginId === routePluginId) return -1;
    if (right.pluginId === routePluginId) return 1;
    return left.bundle.jsBytes - right.bundle.jsBytes;
  });
}

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  };
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => lane(),
  );
  await Promise.all(lanes);
}

interface PluginFrontendReconcileState {
  records: Map<string, PluginFrontendRecord>;
  appliedHashes: Map<string, string>;
  activeGenerations: Map<string, ActivePluginFrontendGeneration>;
  generationByPluginId: Map<string, number>;
  pendingControllers: Map<string, AbortController>;
  pendingStatusOwners: Map<string, symbol>;
  diagnostics: Map<string, PluginFrontendDiagnostic>;
  tornDown: boolean;
}

export function createPluginFrontendReconcileState(): PluginFrontendReconcileState {
  return {
    records: new Map(),
    appliedHashes: new Map(),
    activeGenerations: new Map(),
    generationByPluginId: new Map(),
    pendingControllers: new Map(),
    pendingStatusOwners: new Map(),
    diagnostics: new Map(),
    tornDown: false,
  };
}

export interface PluginFrontendReconcileDeps {
  fetchCandidates: () => Promise<PluginFrontendCandidate[]>;
  importModule: (url: string) => Promise<unknown>;
  applyCss: (pluginId: string, url: string | null) => void | Promise<void>;
  retainCss: (pluginId: string) => () => void;
  resetCrashedSlots: (pluginId: string) => void;
  setRegistrations: (
    pluginId: string,
    registrations: PluginRegistrationSet,
  ) => void;
  removeRegistrations: (pluginId: string) => void;
  beginSlotBatch: () => () => void;
  warn: (message: string) => void;
  routePluginId: () => string | null;
  mountTimeoutMs?: number;
  diagnosticsChanged?: () => void;
}

interface MountedContentScript {
  id: string;
  dispose: PluginContentScriptDisposer | null;
}

interface ActivePluginFrontendGeneration {
  generation: number;
  hash: string;
  controller: AbortController;
  statusOwner: symbol;
  scripts: MountedContentScript[];
  cssRelease: (() => void) | null;
  disposed: boolean;
}

const DEFAULT_CONTENT_SCRIPT_MOUNT_TIMEOUT_MS = 10_000;

class ContentScriptMountError extends Error {
  constructor(
    readonly scriptId: string,
    message: string,
  ) {
    super(message);
    this.name = "ContentScriptMountError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishDiagnostic(
  state: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
  diagnostic: PluginFrontendDiagnostic,
): void {
  state.diagnostics.set(diagnostic.pluginId, diagnostic);
  deps.diagnosticsChanged?.();
}

async function callDisposer(
  pluginId: string,
  scriptId: string,
  disposer: PluginContentScriptDisposer,
  deps: PluginFrontendReconcileDeps,
): Promise<PluginFrontendFailure | null> {
  try {
    await runWithPluginDomIsolationAsync(() => disposer(), pluginId);
    return null;
  } catch (error) {
    const message = errorMessage(error);
    deps.warn(
      `[plugin:${pluginId}] content script "${scriptId}" cleanup failed: ${message}`,
    );
    return { phase: "dispose", message, scriptId };
  }
}

async function disposeGeneration(
  pluginId: string,
  activation: ActivePluginFrontendGeneration,
  deps: PluginFrontendReconcileDeps,
): Promise<PluginFrontendFailure[]> {
  if (activation.disposed) return [];
  activation.disposed = true;
  activation.controller.abort();
  const failures: PluginFrontendFailure[] = [];
  for (const script of [...activation.scripts].reverse()) {
    if (script.dispose === null) continue;
    const failure = await callDisposer(
      pluginId,
      script.id,
      script.dispose,
      deps,
    );
    if (failure !== null) failures.push(failure);
  }
  activation.cssRelease?.();
  activation.cssRelease = null;
  clearPluginThreadRowStatusesByOwner(activation.statusOwner);
  return failures;
}

async function deactivateCommittedGeneration(
  pluginId: string,
  state: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
  removePublishedUi = true,
): Promise<PluginFrontendFailure[]> {
  const active = state.activeGenerations.get(pluginId);
  if (active === undefined) {
    clearPluginThreadRowStatuses(pluginId);
    return [];
  }
  const failures = await disposeGeneration(pluginId, active, deps);
  clearPluginThreadRowStatuses(pluginId);
  state.activeGenerations.delete(pluginId);
  state.appliedHashes.delete(pluginId);
  if (removePublishedUi) {
    deps.removeRegistrations(pluginId);
    deps.applyCss(pluginId, null);
  }
  return failures;
}

async function mountWithTimeout(
  pluginId: string,
  registration: PluginContentScriptRegistration,
  generation: number,
  controller: AbortController,
  statusOwner: symbol,
  deps: PluginFrontendReconcileDeps,
): Promise<PluginContentScriptDisposer | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const mountPromise = Promise.resolve().then(() =>
    runWithPluginDomIsolationAsync(
      () =>
        registration.mount({
          pluginId,
          generation,
          signal: controller.signal,
          experimental_setThreadRowStatus: (
            threadId: unknown,
            status: unknown,
          ) => {
            if (controller.signal.aborted) return;
            if (typeof threadId !== "string") {
              deps.warn(
                `bb plugin "${pluginId}": contentScript.experimental_setThreadRowStatus: "threadId" must be a non-empty string`,
              );
              return;
            }
            const normalizedThreadId = threadId.trim();
            if (normalizedThreadId.length === 0) {
              deps.warn(
                `bb plugin "${pluginId}": contentScript.experimental_setThreadRowStatus: "threadId" must be a non-empty string`,
              );
              return;
            }
            const normalizedStatus = normalizePluginThreadRowStatus(
              status,
              (reason) => deps.warn(`bb plugin "${pluginId}": ${reason}`),
            );
            if (normalizedStatus === undefined) return;
            setPluginThreadRowStatus(
              normalizedThreadId,
              pluginId,
              normalizedStatus,
              statusOwner,
            );
          },
        }),
      pluginId,
      controller.signal,
    ),
  );
  const timeoutMs =
    deps.mountTimeoutMs ?? DEFAULT_CONTENT_SCRIPT_MOUNT_TIMEOUT_MS;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new ContentScriptMountError(
          registration.id,
          `mount timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const disposer = await Promise.race([mountPromise, timeoutPromise]);
    if (disposer !== undefined && typeof disposer !== "function") {
      throw new ContentScriptMountError(
        registration.id,
        "mount must return a cleanup function, a promise of one, or nothing",
      );
    }
    return disposer ?? null;
  } catch (error) {
    if (error instanceof ContentScriptMountError) throw error;
    throw new ContentScriptMountError(registration.id, errorMessage(error));
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (timedOut) {
      void mountPromise
        .then(async (lateDisposer) => {
          if (typeof lateDisposer === "function") {
            await callDisposer(pluginId, registration.id, lateDisposer, deps);
          }
        })
        .catch(() => {});
    }
  }
}

async function activateContentScripts(
  pluginId: string,
  hash: string,
  generation: number,
  registrations: readonly PluginContentScriptRegistration[],
  controller: AbortController,
  statusOwner: symbol,
  cssRelease: (() => void) | null,
  deps: PluginFrontendReconcileDeps,
): Promise<
  | { ok: true; activation: ActivePluginFrontendGeneration }
  | { ok: false; failure: PluginFrontendFailure }
> {
  const activation: ActivePluginFrontendGeneration = {
    generation,
    hash,
    controller,
    statusOwner,
    scripts: [],
    cssRelease,
    disposed: false,
  };
  try {
    for (const registration of registrations) {
      const dispose = await mountWithTimeout(
        pluginId,
        registration,
        generation,
        controller,
        statusOwner,
        deps,
      );
      activation.scripts.push({ id: registration.id, dispose });
    }
    return { ok: true, activation };
  } catch (error) {
    controller.abort();
    await disposeGeneration(pluginId, activation, deps);
    const scriptId =
      error instanceof ContentScriptMountError ? error.scriptId : null;
    const message = errorMessage(error);
    deps.warn(
      `[plugin:${pluginId}] content script${scriptId === null ? "" : ` "${scriptId}"`} mount failed: ${message}`,
    );
    return {
      ok: false,
      failure: { phase: "mount", message, scriptId },
    };
  }
}

export async function reconcilePluginFrontends(
  state: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
): Promise<void> {
  if (state.tornDown) return;
  const candidates = await deps.fetchCandidates();
  if (state.tornDown) return;
  const candidateIds = new Set(candidates.map((c) => c.pluginId));
  for (const pluginId of [...state.records.keys()]) {
    if (candidateIds.has(pluginId)) continue;
    state.pendingControllers.get(pluginId)?.abort();
    state.pendingControllers.delete(pluginId);
    await deactivateCommittedGeneration(pluginId, state, deps);
    state.records.delete(pluginId);
    state.appliedHashes.delete(pluginId);
    state.diagnostics.delete(pluginId);
    deps.diagnosticsChanged?.();
  }
  const closeSlotBatch = deps.beginSlotBatch();
  try {
    await reconcileCandidates(candidates, state, deps);
  } finally {
    closeSlotBatch();
  }
}

async function reconcileCandidates(
  candidates: readonly PluginFrontendCandidate[],
  state: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
): Promise<void> {
  await runWithConcurrencyLimit(
    orderPluginFrontendCandidates(candidates, deps.routePluginId()),
    PLUGIN_FRONTEND_LOAD_CONCURRENCY,
    async (candidate) => {
      const pluginId = candidate.pluginId;
      const previous = state.records.get(pluginId);
      if (
        previous !== undefined &&
        previous.status !== "failed" &&
        state.appliedHashes.get(pluginId) === candidate.bundle.hash
      ) {
        return;
      }
      deps.resetCrashedSlots(pluginId);
      const loaded = await loadPluginFrontends([candidate], {
        importModule: deps.importModule,
        injectCss: () => {},
        warn: deps.warn,
      });
      const record = loaded.get(pluginId);
      if (record === undefined) return;
      if (record.status === "failed") {
        await deactivateCommittedGeneration(pluginId, state, deps);
        state.records.set(pluginId, record);
        publishDiagnostic(state, deps, {
          pluginId,
          status: "failed",
          active: null,
          lastFailure: {
            phase: "load",
            message: record.error,
            scriptId: null,
          },
        });
        return;
      }
      if (record.status === "needs-update") {
        await deactivateCommittedGeneration(pluginId, state, deps);
        state.records.set(pluginId, record);
        publishDiagnostic(state, deps, {
          pluginId,
          status: "needs-update",
          active: null,
          sdkMajor: record.sdkMajor,
          sdkVersion: record.sdkVersion,
          lastFailure: null,
        });
        return;
      }

      let collected: ReturnType<typeof collectPluginAppRegistrations>;
      try {
        const definition = record.module.default;
        if (!isPluginAppDefinition(definition)) {
          throw new Error(
            "the bundle's default export is not definePluginApp(...) from @get-bb/plugin-sdk/app",
          );
        }
        collected = collectPluginAppRegistrations(definition, (reason) => {
          deps.warn(
            `[plugin:${pluginId}] composer customization rejected: ${reason}`,
          );
        });
      } catch (error) {
        const message = errorMessage(error);
        deps.warn(
          `[plugin:${pluginId}] frontend registration failed: ${message}`,
        );
        await deactivateCommittedGeneration(pluginId, state, deps);
        const failed: PluginFrontendRecord = {
          pluginId,
          status: "failed",
          error: message,
        };
        state.records.set(pluginId, failed);
        publishDiagnostic(state, deps, {
          pluginId,
          status: "failed",
          active: null,
          lastFailure: { phase: "setup", message, scriptId: null },
        });
        return;
      }

      const generation = (state.generationByPluginId.get(pluginId) ?? 0) + 1;
      state.generationByPluginId.set(pluginId, generation);
      await deps.applyCss(pluginId, candidate.bundle.cssUrl);
      const cssRelease =
        collected.contentScripts.length > 0 ? deps.retainCss(pluginId) : null;
      const disposeFailures = await deactivateCommittedGeneration(
        pluginId,
        state,
        deps,
        false,
      );
      const controller = new AbortController();
      const statusOwner = Symbol(
        `${pluginId}:content-script-generation:${generation}`,
      );
      state.pendingControllers.set(pluginId, controller);
      state.pendingStatusOwners.set(pluginId, statusOwner);
      const activationResult = await activateContentScripts(
        pluginId,
        candidate.bundle.hash,
        generation,
        collected.contentScripts,
        controller,
        statusOwner,
        cssRelease,
        deps,
      );
      state.pendingControllers.delete(pluginId);
      state.pendingStatusOwners.delete(pluginId);
      if (state.tornDown) {
        if (activationResult.ok) {
          await disposeGeneration(pluginId, activationResult.activation, deps);
        }
        deps.removeRegistrations(pluginId);
        deps.applyCss(pluginId, null);
        return;
      }
      if (!activationResult.ok) {
        deps.removeRegistrations(pluginId);
        deps.applyCss(pluginId, null);
        const failed: PluginFrontendRecord = {
          pluginId,
          status: "failed",
          error: activationResult.failure.message,
        };
        state.records.set(pluginId, failed);
        publishDiagnostic(state, deps, {
          pluginId,
          status: "failed",
          active: null,
          lastFailure: activationResult.failure,
        });
        return;
      }

      state.activeGenerations.set(pluginId, activationResult.activation);
      deps.setRegistrations(pluginId, collected);
      state.records.set(pluginId, record);
      state.appliedHashes.set(pluginId, candidate.bundle.hash);
      publishDiagnostic(state, deps, {
        pluginId,
        status: "active",
        active: {
          generation: activationResult.activation.generation,
          hash: activationResult.activation.hash,
          contentScriptIds: activationResult.activation.scripts.map(
            ({ id }) => id,
          ),
        },
        lastFailure: disposeFailures[0] ?? null,
      });
    },
  );
}

export async function disposePluginFrontends(
  state: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
): Promise<void> {
  state.tornDown = true;
  const pendingPluginIds = [...state.pendingControllers.keys()];
  for (const [pluginId, controller] of state.pendingControllers) {
    controller.abort();
    const statusOwner = state.pendingStatusOwners.get(pluginId);
    if (statusOwner !== undefined) {
      clearPluginThreadRowStatusesByOwner(statusOwner);
    }
  }
  state.pendingControllers.clear();
  state.pendingStatusOwners.clear();
  const pluginIds = new Set([
    ...pendingPluginIds,
    ...state.records.keys(),
    ...state.activeGenerations.keys(),
  ]);
  for (const pluginId of pluginIds) {
    const active = state.activeGenerations.get(pluginId);
    if (active !== undefined) {
      await disposeGeneration(pluginId, active, deps);
    }
    clearPluginThreadRowStatuses(pluginId);
    deps.removeRegistrations(pluginId);
    deps.applyCss(pluginId, null);
  }
  state.records.clear();
  state.appliedHashes.clear();
  state.activeGenerations.clear();
  state.diagnostics.clear();
  deps.diagnosticsChanged?.();
}

export function createPluginFrontendReconcileScheduler(args: {
  run: () => Promise<void>;
  debounceMs?: number;
}): { schedule: () => void } {
  const debounceMs = args.debounceMs ?? 250;
  let inFlight = false;
  let queued = false;
  const execute = async (): Promise<void> => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await args.run();
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void execute();
      }
    }
  };
  const scheduler = createDebouncedCallbackScheduler({
    debounceMs,
    maxWaitMs: debounceMs * 4,
    onFlush: () => void execute(),
  });
  return { schedule: () => scheduler.schedule() };
}

const state = createPluginFrontendReconcileState();
let bootPromise: Promise<void> | null = null;
let browserDiagnosticsSnapshot: ReadonlyMap<string, PluginFrontendDiagnostic> =
  new Map();
const browserDiagnosticsListeners = new Set<() => void>();

function publishBrowserDiagnostics(): void {
  browserDiagnosticsSnapshot = new Map(state.diagnostics);
  for (const listener of browserDiagnosticsListeners) listener();
}

const PLUGIN_SLOT_BATCH_MAX_HOLD_MS = 150;

const browserReconcileDeps: PluginFrontendReconcileDeps = {
  fetchCandidates: fetchFrontendCandidates,
  importModule: (url) => import(/* @vite-ignore */ url),
  applyCss: applyPluginCss,
  retainCss: retainPluginCss,
  routePluginId: () => getPluginPanelRoutePluginId(window.location.pathname),
  resetCrashedSlots: resetCrashedPluginSlots,
  setRegistrations: setPluginSlotRegistrations,
  removeRegistrations: removePluginSlotRegistrations,
  beginSlotBatch: () =>
    beginPluginSlotBatch({ maxHoldMs: PLUGIN_SLOT_BATCH_MAX_HOLD_MS }),
  warn: (message) => console.warn(message),
  diagnosticsChanged: publishBrowserDiagnostics,
};

export function getPluginFrontendDiagnostics(): ReadonlyMap<
  string,
  PluginFrontendDiagnostic
> {
  return browserDiagnosticsSnapshot;
}

export function subscribePluginFrontendDiagnostics(
  listener: () => void,
): () => void {
  browserDiagnosticsListeners.add(listener);
  return () => {
    browserDiagnosticsListeners.delete(listener);
  };
}

interface PluginFrontendPageLifecycleDeps {
  restore: () => void;
  teardown: () => void;
}

export function createPluginFrontendPageLifecycle(
  deps: PluginFrontendPageLifecycleDeps,
): {
  onPageHide: (event: { persisted: boolean }) => void;
  onPageShow: (event: { persisted: boolean }) => void;
} {
  return {
    onPageHide(event) {
      if (event.persisted) return;
      deps.teardown();
    },
    onPageShow(event) {
      if (!event.persisted) return;
      deps.restore();
    },
  };
}

let pageLifecycleListenersInstalled = false;

function installPluginFrontendPageLifecycle(): void {
  if (pageLifecycleListenersInstalled) return;
  pageLifecycleListenersInstalled = true;
  const lifecycle = createPluginFrontendPageLifecycle({
    restore: () => schedulePluginFrontendReconcile(),
    teardown: () => {
      void disposePluginFrontends(state, browserReconcileDeps);
    },
  });
  window.addEventListener("pagehide", (event) => lifecycle.onPageHide(event));
  window.addEventListener("pageshow", (event) => lifecycle.onPageShow(event));
}

export function bootPluginFrontends(): Promise<void> {
  bootPromise ??= (async () => {
    installPluginRuntime();
    installPluginFrontendPageLifecycle();
    await reconcilePluginFrontends(state, browserReconcileDeps);
  })().catch((error: unknown) => {
    console.warn(
      `plugin frontend boot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return bootPromise;
}

async function runLiveReconcile(): Promise<void> {
  try {
    await bootPromise;
    await markEnabledPluginListStale({ queryClient: appQueryClient });
    if (state.tornDown) {
      state.tornDown = false;
      bootPromise = null;
      await bootPluginFrontends();
      return;
    }
    await reconcilePluginFrontends(state, browserReconcileDeps);
  } catch (error) {
    console.warn(
      `plugin frontend reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let liveScheduler: { schedule: () => void } | null = null;

export function schedulePluginFrontendReconcile(): void {
  if (bootPromise === null) return;
  liveScheduler ??= createPluginFrontendReconcileScheduler({
    run: runLiveReconcile,
  });
  liveScheduler.schedule();
}
