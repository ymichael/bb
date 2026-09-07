import type {
  ComposerCustomization,
  ExperimentalAppOverlayRegistration,
  ExperimentalSidebarFooter,
  ExperimentalSidebarFooterActionContext,
  ExperimentalSidebarFooterActionRegistration,
  ExperimentalSidebarFooterDisclosureController,
  ExperimentalSidebarFooterDisclosureRegistration,
  ExperimentalSidebarFooterItemRegistration,
  PluginAppDefinition,
  PluginContentScriptRegistration,
  PluginDiffRendererRegistration,
  PluginFileOpenerRegistration,
  PluginHomepageSectionRegistration,
  PluginCommandPaletteActionRegistration,
  PluginMessageActionRegistration,
  PluginMessageDirectiveRegistration,
  PluginNavPanelRegistration,
  PluginNewThreadPanelActionRegistration,
  PluginPendingInteractionRegistration,
  PluginProviderIconRegistration,
  PluginSettingsSectionRegistration,
  PluginSidebarFooterActionRegistration,
  ExperimentalSidebarNavigationRegistration,
  PluginSourceCodeRendererRegistration,
  PluginThreadHeaderActionRegistration,
  PluginThreadListRegistration,
  PluginThreadPanelActionRegistration,
  PluginTimelineRendererRegistration,
} from "@get-bb/plugin-sdk";
import {
  collectComposerCustomization,
  PLUGIN_SLOT_ID_PATTERN,
  requireComponent,
  requireMessageDirectiveId,
  requireNonEmptyString,
  requireOptionalString,
  requireProviderId,
  requireSlotId,
  requireTimelineRendererKind,
  requireUniqueId,
} from "./composer-customization-validation.js";

export type ExperimentalSidebarFooterCommandKind = "open" | "close" | "toggle";

export interface ExperimentalSidebarFooterRuntimeSnapshot {
  command: {
    sequence: number;
    kind: ExperimentalSidebarFooterCommandKind;
  } | null;
}

export interface ExperimentalSidebarFooterItemRuntime {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ExperimentalSidebarFooterRuntimeSnapshot;
  acknowledgeCommand(sequence: number): void;
}

export type CollectedExperimentalSidebarFooterItem =
  ExperimentalSidebarFooterItemRegistration & {
    runtime: ExperimentalSidebarFooterItemRuntime;
  };

export type CollectedManagedSidebarFooterItem =
  CollectedExperimentalSidebarFooterItem & {
    source: "experimental_sidebarFooter";
  };

export interface CollectedCompatibilitySidebarFooterItem {
  source: "sidebarFooterAction";
  id: string;
  label: string;
  icon: string;
  kind: "action";
  onActivate(
    context: ExperimentalSidebarFooterActionContext,
  ): void | Promise<void>;
  runtime: ExperimentalSidebarFooterItemRuntime;
}

export type CollectedSidebarFooterItem =
  | CollectedCompatibilitySidebarFooterItem
  | CollectedManagedSidebarFooterItem;

let sidebarFooterCommandSequence = 0;

const SIDEBAR_FOOTER_ACTION_KEYS: ReadonlySet<string> = new Set([
  "id",
  "label",
  "icon",
  "kind",
  "onActivate",
]);

const SIDEBAR_FOOTER_DISCLOSURE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "label",
  "icon",
  "kind",
  "component",
]);

class SidebarFooterItemRuntime implements ExperimentalSidebarFooterItemRuntime {
  private readonly listeners = new Set<() => void>();
  private snapshot: ExperimentalSidebarFooterRuntimeSnapshot = {
    command: null,
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ExperimentalSidebarFooterRuntimeSnapshot =>
    this.snapshot;

  readonly acknowledgeCommand = (sequence: number): void => {
    if (this.snapshot.command?.sequence !== sequence) return;
    this.snapshot = { ...this.snapshot, command: null };
    this.emit();
  };

  createDisclosureController(): ExperimentalSidebarFooterDisclosureController {
    return Object.freeze({
      open: () => this.request("open"),
      close: () => this.request("close"),
      toggle: () => this.request("toggle"),
    });
  }

  private request(kind: ExperimentalSidebarFooterCommandKind): void {
    sidebarFooterCommandSequence += 1;
    this.snapshot = {
      ...this.snapshot,
      command: { sequence: sidebarFooterCommandSequence, kind },
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function adaptSidebarFooterAction(
  registration: PluginSidebarFooterActionRegistration,
): CollectedCompatibilitySidebarFooterItem {
  return {
    source: "sidebarFooterAction",
    id: registration.id,
    label: registration.title,
    icon: registration.icon,
    kind: "action",
    onActivate: ({ openPluginDetails }) =>
      registration.run({ openSettings: openPluginDetails }),
    runtime: new SidebarFooterItemRuntime(),
  };
}

class SidebarFooterCollector implements ExperimentalSidebarFooter {
  constructor(
    private readonly collected: CollectedExperimentalSidebarFooterItem[],
    private readonly allCollected: CollectedSidebarFooterItem[],
    private readonly seenIds: Set<string>,
  ) {}

  register(registration: ExperimentalSidebarFooterActionRegistration): void;
  register(
    registration: ExperimentalSidebarFooterDisclosureRegistration,
  ): ExperimentalSidebarFooterDisclosureController;
  register(
    registration: ExperimentalSidebarFooterItemRegistration,
  ): void | ExperimentalSidebarFooterDisclosureController {
    const kind = "experimental_sidebarFooter.register";
    const id = requireSlotId(kind, registration?.id);
    requireUniqueId(kind, this.seenIds, id);
    const label = requireNonEmptyString(kind, "label", registration.label);
    const icon = requireNonEmptyString(kind, "icon", registration.icon);
    const runtime = new SidebarFooterItemRuntime();

    if (registration.kind === "action") {
      this.rejectUnknownKeys(kind, registration, SIDEBAR_FOOTER_ACTION_KEYS);
      if (typeof registration.onActivate !== "function") {
        throw new Error(`${kind}: "onActivate" must be a function`);
      }
      const item: CollectedManagedSidebarFooterItem = {
        id,
        label,
        icon,
        kind: "action",
        onActivate: registration.onActivate,
        source: "experimental_sidebarFooter",
        runtime,
      };
      this.collected.push(item);
      this.allCollected.push(item);
      return;
    }

    if (registration.kind === "disclosure") {
      this.rejectUnknownKeys(
        kind,
        registration,
        SIDEBAR_FOOTER_DISCLOSURE_KEYS,
      );
      const item: CollectedManagedSidebarFooterItem = {
        id,
        label,
        icon,
        kind: "disclosure",
        component: requireComponent(kind, registration.component),
        source: "experimental_sidebarFooter",
        runtime,
      };
      this.collected.push(item);
      this.allCollected.push(item);
      return runtime.createDisclosureController();
    }

    throw new Error(`${kind}: "kind" must be "action" or "disclosure"`);
  }

  private rejectUnknownKeys(
    kind: string,
    registration: ExperimentalSidebarFooterItemRegistration,
    allowed: ReadonlySet<string>,
  ): void {
    for (const key of Object.keys(registration)) {
      if (!allowed.has(key)) throw new Error(`${kind}: unknown field "${key}"`);
    }
  }
}

type PluginNavPanelFixedTabRegistration = NonNullable<
  PluginNavPanelRegistration["fixedTabs"]
>[number];

/**
 * The keys a navPanel registration may carry, pinned to the contract so a
 * renamed or removed field cannot drift out of this list unnoticed.
 */
const NAV_PANEL_REGISTRATION_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    id: true,
    title: true,
    icon: true,
    path: true,
    component: true,
    fixedTabs: true,
    experimental_sidebarAccessory: true,
    headerContent: true,
  } satisfies Record<keyof PluginNavPanelRegistration, true>),
);

/** Old navPanel keys and the names that replaced them (SDK 0.4.16). */
const RENAMED_NAV_PANEL_KEYS: ReadonlyMap<string, string> = new Map([
  ["experimental_fixedTabs", "fixedTabs"],
]);

/**
 * A plugin built against an SDK before 0.4.16 still passes
 * `experimental_fixedTabs`. Silently dropping it would leave the panel
 * without its tabs and no error (accepted-but-ignored fields are forbidden),
 * so a renamed key fails with its new name and any other stale
 * `experimental_` key fails as unknown.
 */
function rejectStaleNavPanelKeys(kind: string, registration: object): void {
  for (const key of Object.keys(registration)) {
    if (NAV_PANEL_REGISTRATION_KEYS.has(key)) continue;
    const renamedTo = RENAMED_NAV_PANEL_KEYS.get(key);
    if (renamedTo !== undefined) {
      throw new Error(
        `${kind}: "${key}" was renamed to "${renamedTo}" in SDK 0.4.16`,
      );
    }
    if (key.startsWith("experimental_")) {
      throw new Error(`${kind}: unknown field "${key}"`);
    }
  }
}

/** Validated registrations produced by one plugin app setup execution. */
export interface CollectedPluginAppRegistrations {
  homepageSections: PluginHomepageSectionRegistration[];
  settingsSections: PluginSettingsSectionRegistration[];
  appOverlays: ExperimentalAppOverlayRegistration[];
  navPanels: PluginNavPanelRegistration[];
  threadPanelActions: PluginThreadPanelActionRegistration[];
  newThreadPanelActions: PluginNewThreadPanelActionRegistration[];
  composerCustomizations: ComposerCustomization[];
  pendingInteractions: PluginPendingInteractionRegistration[];
  sidebarFooterActions: PluginSidebarFooterActionRegistration[];
  experimentalSidebarFooterItems: CollectedExperimentalSidebarFooterItem[];
  experimentalSidebarNavigations: ExperimentalSidebarNavigationRegistration[];
  threadLists: PluginThreadListRegistration[];
  threadHeaderActions: PluginThreadHeaderActionRegistration[];
  fileOpeners: PluginFileOpenerRegistration[];
  sourceCodeRenderers: PluginSourceCodeRendererRegistration[];
  diffRenderers: PluginDiffRendererRegistration[];
  messageDirectives: PluginMessageDirectiveRegistration[];
  messageActions: PluginMessageActionRegistration[];
  commandPaletteActions: PluginCommandPaletteActionRegistration[];
  providerIcons: PluginProviderIconRegistration[];
  timelineRenderers: PluginTimelineRendererRegistration[];
  contentScripts: PluginContentScriptRegistration[];
}

const sidebarFooterItemsByRegistrationSet = new WeakMap<
  object,
  readonly CollectedSidebarFooterItem[]
>();

export function getCollectedSidebarFooterItems(
  registrations: object,
): readonly CollectedSidebarFooterItem[] | null {
  return sidebarFooterItemsByRegistrationSet.get(registrations) ?? null;
}

/**
 * Run a plugin app definition against the canonical validating collector.
 * Both the BB app and the public test harness use this implementation so a
 * registration accepted by one cannot be rejected or normalized differently
 * by the other.
 */
export function collectPluginAppRegistrations(
  definition: PluginAppDefinition,
  onComposerCustomizationRejected: (reason: string) => void = (reason) =>
    console.warn(reason),
): CollectedPluginAppRegistrations {
  const sidebarFooterItems: CollectedSidebarFooterItem[] = [];
  const collected: CollectedPluginAppRegistrations = {
    homepageSections: [],
    settingsSections: [],
    appOverlays: [],
    navPanels: [],
    threadPanelActions: [],
    newThreadPanelActions: [],
    composerCustomizations: [],
    pendingInteractions: [],
    sidebarFooterActions: [],
    experimentalSidebarFooterItems: [],
    experimentalSidebarNavigations: [],
    threadLists: [],
    threadHeaderActions: [],
    fileOpeners: [],
    sourceCodeRenderers: [],
    diffRenderers: [],
    messageDirectives: [],
    messageActions: [],
    commandPaletteActions: [],
    providerIcons: [],
    timelineRenderers: [],
    contentScripts: [],
  };
  sidebarFooterItemsByRegistrationSet.set(collected, sidebarFooterItems);
  const seenIds = {
    homepageSection: new Set<string>(),
    settingsSection: new Set<string>(),
    appOverlay: new Set<string>(),
    navPanel: new Set<string>(),
    threadPanelAction: new Set<string>(),
    newThreadPanelAction: new Set<string>(),
    composerCustomization: new Set<string>(),
    pendingInteraction: new Set<string>(),
    sidebarFooterItem: new Set<string>(),
    sidebarNavigation: new Set<string>(),
    threadList: new Set<string>(),
    threadHeaderAction: new Set<string>(),
    fileOpener: new Set<string>(),
    sourceCodeRenderer: new Set<string>(),
    diffRenderer: new Set<string>(),
    messageDirective: new Set<string>(),
    messageAction: new Set<string>(),
    commandPaletteAction: new Set<string>(),
    providerIcon: new Set<string>(),
    timelineRenderer: new Set<string>(),
    contentScript: new Set<string>(),
  };

  definition.setup({
    slots: {
      homepageSection(registration) {
        const kind = "slots.homepageSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.homepageSection, id);
        collected.homepageSections.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          component: requireComponent(kind, registration.component),
        });
      },
      settingsSection(registration) {
        const kind = "slots.settingsSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.settingsSection, id);
        const title = requireOptionalString(kind, "title", registration.title);
        const description = requireOptionalString(
          kind,
          "description",
          registration.description,
        );
        collected.settingsSections.push({
          id,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          component: requireComponent(kind, registration.component),
        });
      },
      experimental_appOverlay(registration) {
        const kind = "slots.experimental_appOverlay";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.appOverlay, id);
        collected.appOverlays.push({
          id,
          component: requireComponent(kind, registration.component),
        });
      },
      navPanel(registration) {
        const kind = "slots.navPanel";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.navPanel, id);
        rejectStaleNavPanelKeys(kind, registration);
        const panelId = id;
        const path = requireNonEmptyString(kind, "path", registration.path);
        if (!PLUGIN_SLOT_ID_PATTERN.test(path)) {
          throw new Error(
            `${kind}: "path" must match ${String(PLUGIN_SLOT_ID_PATTERN)} (it becomes a URL segment), got ${JSON.stringify(path)}`,
          );
        }
        if (
          registration.headerContent !== undefined &&
          typeof registration.headerContent !== "function"
        ) {
          throw new Error(
            `${kind}: "headerContent" must be a React component function when set`,
          );
        }
        if (
          registration.experimental_sidebarAccessory !== undefined &&
          typeof registration.experimental_sidebarAccessory !== "function"
        ) {
          throw new Error(
            `${kind}: "experimental_sidebarAccessory" must be a React component function when set`,
          );
        }
        const fixedTabs: PluginNavPanelFixedTabRegistration[] = (() => {
          if (registration.fixedTabs === undefined) return [];
          if (!Array.isArray(registration.fixedTabs)) {
            throw new Error(`${kind}: "fixedTabs" must be an array when set`);
          }
          const seenFixedTabIds = new Set<string>();
          return registration.fixedTabs.map((value, index) => {
            const fixedTabKind = `${kind}.fixedTabs[${index}]`;
            const fixedTab = value as Record<string, unknown> | null;
            const id = requireSlotId(fixedTabKind, fixedTab?.id);
            requireUniqueId(fixedTabKind, seenFixedTabIds, id);
            const layout = fixedTab?.layout;
            if (
              layout !== undefined &&
              layout !== "padded" &&
              layout !== "flush"
            ) {
              throw new Error(
                `${fixedTabKind}: "layout" must be "padded" or "flush" when set`,
              );
            }
            const fixedTabPanelId = requireNonEmptyString(
              fixedTabKind,
              "panelId",
              fixedTab?.panelId,
            );
            if (fixedTabPanelId !== panelId) {
              throw new Error(
                `${fixedTabKind}: "panelId" must match its containing navPanel id ${JSON.stringify(panelId)}`,
              );
            }
            const experimentalTarget = fixedTab?.experimental_target;
            if (
              experimentalTarget !== undefined &&
              (typeof experimentalTarget !== "object" ||
                experimentalTarget === null ||
                typeof Reflect.get(experimentalTarget, "validate") !==
                  "function")
            ) {
              throw new Error(
                `${fixedTabKind}: "experimental_target.validate" must be a function when set`,
              );
            }
            return {
              id,
              panelId: fixedTabPanelId,
              title: requireNonEmptyString(
                fixedTabKind,
                "title",
                fixedTab?.title,
              ),
              icon: requireNonEmptyString(fixedTabKind, "icon", fixedTab?.icon),
              component: requireComponent<
                PluginNavPanelFixedTabRegistration["component"]
              >(fixedTabKind, fixedTab?.component),
              ...(layout === undefined ? {} : { layout }),
              ...(experimentalTarget === undefined
                ? {}
                : {
                    experimental_target:
                      experimentalTarget as PluginNavPanelFixedTabRegistration["experimental_target"],
                  }),
            };
          });
        })();
        collected.navPanels.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          icon: requireNonEmptyString(kind, "icon", registration.icon),
          path,
          component: requireComponent(kind, registration.component),
          ...(fixedTabs.length > 0 ? { fixedTabs } : {}),
          ...(registration.experimental_sidebarAccessory !== undefined
            ? {
                experimental_sidebarAccessory:
                  registration.experimental_sidebarAccessory,
              }
            : {}),
          ...(registration.headerContent !== undefined
            ? { headerContent: registration.headerContent }
            : {}),
        });
      },
      threadPanelAction(registration) {
        const kind = "slots.threadPanelAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadPanelAction, id);
        if (
          registration.run !== undefined &&
          typeof registration.run !== "function"
        ) {
          throw new Error(`${kind}: "run" must be a function when set`);
        }
        if (
          registration.layout !== undefined &&
          registration.layout !== "padded" &&
          registration.layout !== "flush"
        ) {
          throw new Error(`${kind}: "layout" must be "padded" or "flush"`);
        }
        collected.threadPanelActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(registration.icon !== undefined
            ? {
                icon: requireNonEmptyString(kind, "icon", registration.icon),
              }
            : {}),
          component: requireComponent(kind, registration.component),
          ...(registration.layout !== undefined
            ? { layout: registration.layout }
            : {}),
          ...(registration.run !== undefined ? { run: registration.run } : {}),
        });
      },
      experimental_newThreadPanelAction(registration) {
        const kind = "slots.experimental_newThreadPanelAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.newThreadPanelAction, id);
        if (
          registration.run !== undefined &&
          typeof registration.run !== "function"
        ) {
          throw new Error(`${kind}: "run" must be a function when set`);
        }
        if (
          registration.layout !== undefined &&
          registration.layout !== "padded" &&
          registration.layout !== "flush"
        ) {
          throw new Error(`${kind}: "layout" must be "padded" or "flush"`);
        }
        collected.newThreadPanelActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(registration.icon !== undefined
            ? {
                icon: requireNonEmptyString(kind, "icon", registration.icon),
              }
            : {}),
          component: requireComponent(kind, registration.component),
          ...(registration.layout !== undefined
            ? { layout: registration.layout }
            : {}),
          ...(registration.run !== undefined ? { run: registration.run } : {}),
        });
      },
      pendingInteraction(registration) {
        const kind = "slots.pendingInteraction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.pendingInteraction, id);
        collected.pendingInteractions.push({
          id,
          component: requireComponent(kind, registration.component),
        });
      },
      sidebarFooterAction(registration) {
        const kind = "slots.sidebarFooterAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.sidebarFooterItem, id);
        if (typeof registration.run !== "function") {
          throw new Error(`${kind}: "run" must be a function`);
        }
        const legacyRegistration = {
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          icon: requireNonEmptyString(kind, "icon", registration.icon),
          run: registration.run,
        };
        collected.sidebarFooterActions.push(legacyRegistration);
        sidebarFooterItems.push(adaptSidebarFooterAction(legacyRegistration));
      },
      experimental_sidebarNavigation(registration) {
        const kind = "slots.experimental_sidebarNavigation";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.sidebarNavigation, id);
        const description = requireOptionalString(
          kind,
          "description",
          registration.description,
        );
        collected.experimentalSidebarNavigations.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(description !== undefined ? { description } : {}),
          component: requireComponent(kind, registration.component),
        });
      },
      experimental_threadList(registration) {
        const kind = "slots.experimental_threadList";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadList, id);
        const description = requireOptionalString(
          kind,
          "description",
          registration.description,
        );
        collected.threadLists.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(description !== undefined ? { description } : {}),
          component: requireComponent(kind, registration.component),
        });
      },
      experimental_threadHeaderAction(registration) {
        const kind = "slots.experimental_threadHeaderAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadHeaderAction, id);
        collected.threadHeaderActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          component: requireComponent(kind, registration.component),
        });
      },
      fileOpener(registration) {
        const kind = "slots.fileOpener";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.fileOpener, id);
        const rawExtensions = registration?.extensions;
        if (!Array.isArray(rawExtensions) || rawExtensions.length === 0) {
          throw new Error(
            `${kind}: "extensions" must be a non-empty array of lowercase extensions without the dot`,
          );
        }
        const extensions = rawExtensions.map((extension) => {
          if (typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension)) {
            throw new Error(
              `${kind}: extensions must be lowercase alphanumerics without the dot, got ${JSON.stringify(extension)}`,
            );
          }
          return extension;
        });
        collected.fileOpeners.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          extensions,
          component: requireComponent(kind, registration.component),
        });
      },
      experimental_sourceCodeRenderer(registration) {
        const kind = "slots.experimental_sourceCodeRenderer";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.sourceCodeRenderer, id);
        const description = requireOptionalString(
          kind,
          "description",
          registration.description,
        );
        collected.sourceCodeRenderers.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(description !== undefined ? { description } : {}),
          component: requireComponent(kind, registration.component),
        });
      },
      experimental_diffRenderer(registration) {
        const kind = "slots.experimental_diffRenderer";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.diffRenderer, id);
        const description = requireOptionalString(
          kind,
          "description",
          registration.description,
        );
        collected.diffRenderers.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(description !== undefined ? { description } : {}),
          component: requireComponent(kind, registration.component),
        });
      },
      messageDirective(registration) {
        const kind = "slots.messageDirective";
        const id = requireMessageDirectiveId(kind, registration?.id);
        requireUniqueId(kind, seenIds.messageDirective, id);
        collected.messageDirectives.push({
          id,
          component: requireComponent(kind, registration.component),
        });
      },
      messageAction(registration) {
        const kind = "slots.messageAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.messageAction, id);
        if (typeof registration.run !== "function") {
          throw new Error(`${kind}: "run" must be a function`);
        }
        collected.messageActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(registration.icon !== undefined
            ? {
                icon: requireNonEmptyString(kind, "icon", registration.icon),
              }
            : {}),
          run: registration.run,
        });
      },
      commandPaletteAction(registration) {
        const kind = "slots.commandPaletteAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.commandPaletteAction, id);
        if (typeof registration.run !== "function") {
          throw new Error(`${kind}: "run" must be a function`);
        }
        if (
          registration.isAvailable !== undefined &&
          typeof registration.isAvailable !== "function"
        ) {
          throw new Error(`${kind}: "isAvailable" must be a function`);
        }
        collected.commandPaletteActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...(registration.isAvailable !== undefined
            ? { isAvailable: registration.isAvailable }
            : {}),
          run: registration.run,
        });
      },
      experimental_providerIcon(registration) {
        const kind = "slots.experimental_providerIcon";
        const providerId = requireProviderId(kind, registration?.providerId);
        requireUniqueId(kind, seenIds.providerIcon, providerId);
        collected.providerIcons.push({
          providerId,
          icon: requireComponent(kind, registration.icon),
        });
      },
      experimental_timelineRenderer(registration) {
        const kind = "slots.experimental_timelineRenderer";
        const itemKind = requireTimelineRendererKind(kind, registration?.kind);
        requireUniqueId(kind, seenIds.timelineRenderer, itemKind);
        collected.timelineRenderers.push({
          kind: itemKind,
          component: requireComponent(kind, registration.component),
        });
      },
    },
    experimental_sidebarFooter: new SidebarFooterCollector(
      collected.experimentalSidebarFooterItems,
      sidebarFooterItems,
      seenIds.sidebarFooterItem,
    ),
    composer: {
      customize(registration) {
        const customization = collectComposerCustomization(
          registration,
          seenIds.composerCustomization,
          onComposerCustomizationRejected,
        );
        if (customization !== null) {
          collected.composerCustomizations.push(customization);
        }
      },
    },
    contentScripts: {
      register(registration) {
        const kind = "contentScripts.register";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.contentScript, id);
        if (typeof registration.mount !== "function") {
          throw new Error(`${kind}: "mount" must be a function`);
        }
        collected.contentScripts.push({ id, mount: registration.mount });
      },
    },
  });

  return collected;
}
