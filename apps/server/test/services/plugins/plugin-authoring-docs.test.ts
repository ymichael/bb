import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as pluginSdkApp from "@get-bb/plugin-sdk/app";
import {
  type BbPluginApi,
  type ExperimentalAppOverlayProps,
  type PluginAppBuilder,
  type PluginAppSlots,
  type PluginContentScriptContext,
  type PluginContentScriptRegistration,
  type PluginDiffRendererProps,
  type PluginFileOpenerProps,
  type PluginHomepageSectionProps,
  type PluginHttpAuthMode,
  type PluginCommandPaletteActionContext,
  type PluginCommandPaletteActionRegistration,
  type PluginMessageActionContext,
  type PluginMessageActionRegistration,
  type PluginMessageDirectiveProps,
  type PluginNavPanelProps,
  type PluginNavPanelRegistration,
  type PluginNewThreadPanelProps,
  type PluginPendingInteractionProps,
  type PluginProviderIconRegistration,
  type PluginTimelineRendererProps,
  type PluginSettingDescriptor,
  type PluginSettingsSectionProps,
  type PluginSidebarFooterActionProps,
  type ExperimentalSidebarNavigationProps,
  type PluginSourceCodeRendererProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadListProps,
  type PluginSidebarFooterActionRegistration,
  type PluginThreadEventPayloads,
  type PluginThreadPanelProps,
  type ThreadChatMessageAction,
  type ThreadChatProps,
} from "@get-bb/plugin-sdk";

const FRONTEND_RUNTIME_EXPORT_NAMES = Object.keys(pluginSdkApp).sort();
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const SKILL_ROOT = fileURLToPath(
  new URL(
    "../../../src/services/skills/builtin-skills/bb-plugin-authoring/",
    import.meta.url,
  ),
);
const SKILL_PATH = join(SKILL_ROOT, "SKILL.md");

function readSkillTree(directory = SKILL_ROOT): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return readSkillTree(entryPath);
      return entry.name.endsWith(".md") ? readFileSync(entryPath, "utf8") : [];
    })
    .join("\n");
}

function readReference(name: string): string {
  return readFileSync(join(SKILL_ROOT, "references", name), "utf8");
}

function exportedTypeNames(source: string): string[] {
  return [...source.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function exportedNames(source: string): string[] {
  return [
    ...source.matchAll(
      /^export (?:async )?(?:interface|type|function|const|class) ([A-Za-z0-9_]+)/gm,
    ),
  ]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function declarationExportNames(source: string): string[] {
  return [...source.matchAll(/^export(?: type)? \{([^}]*)\};/gm)].flatMap(
    (match) =>
      (match[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.split(/\s+as\s+/).at(-1) ?? name),
  );
}

const appModule = readFileSync(
  join(REPO_ROOT, "packages/plugin-sdk/src/app.ts"),
  "utf8",
);
const rpcTypeBlock = appModule.match(
  /export type \{([\s\S]*?)\} from "\.\/rpc-contract\.js";/,
)?.[1];
if (!rpcTypeBlock) throw new Error("The app RPC type export block is missing");

const FRONTEND_TYPE_EXPORT_NAMES = [
  ...exportedTypeNames(
    readFileSync(
      join(REPO_ROOT, "packages/plugin-sdk/src/app-contract.ts"),
      "utf8",
    ),
  ),
  ...exportedTypeNames(
    readFileSync(
      join(REPO_ROOT, "packages/plugin-sdk/src/json-value.ts"),
      "utf8",
    ),
  ),
  ...rpcTypeBlock
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
];

const FRONTEND_TEST_EXPORT_NAMES = [
  "packages/plugin-sdk/src/testing/app.tsx",
  "packages/plugin-sdk/src/testing/host.ts",
].flatMap((relativePath) =>
  exportedNames(readFileSync(join(REPO_ROOT, relativePath), "utf8")),
);

const PUBLIC_PLUGIN_SDK_EXPORT_NAMES = [
  "bb-plugin-sdk.d.ts",
  "bb-plugin-sdk-ai-services.d.ts",
  "bb-plugin-sdk-provider-bridge.d.ts",
  "bb-plugin-sdk-provider-bridge-testing.d.ts",
  "bb-plugin-sdk-provider-bridge-acp.d.ts",
  "bb-plugin-sdk-host.d.ts",
  "bb-plugin-sdk-testing.d.ts",
].flatMap((filename) =>
  declarationExportNames(
    readFileSync(
      join(REPO_ROOT, "packages/plugin-sdk/bundled-types", filename),
      "utf8",
    ),
  ),
);

const BB_PLUGIN_API_KEYS = [
  "pluginId",
  "log",
  "settings",
  "storage",
  "http",
  "rpc",
  "realtime",
  "background",
  "cli",
  "agents",
  "providers",
  "ui",
  "events",
  "status",
  "server",
  "hosts",
  "experimental_aiServices",
  "experimental_hooks",
  "sdk",
  "onDispose",
] as const satisfies readonly (keyof BbPluginApi)[];

type MissingApiKey = Exclude<
  keyof BbPluginApi,
  (typeof BB_PLUGIN_API_KEYS)[number]
>;
const _assertAllApiKeysListed: MissingApiKey extends never ? true : never =
  true;
void _assertAllApiKeysListed;

const SETTING_DESCRIPTOR_TYPES = [
  "string",
  "number",
  "boolean",
  "select",
  "project",
] as const satisfies readonly PluginSettingDescriptor["type"][];

type MissingSettingType = Exclude<
  PluginSettingDescriptor["type"],
  (typeof SETTING_DESCRIPTOR_TYPES)[number]
>;
const _assertAllSettingTypesListed: MissingSettingType extends never
  ? true
  : never = true;
void _assertAllSettingTypesListed;

const HTTP_AUTH_MODES = [
  "local",
  "token",
  "none",
] as const satisfies readonly PluginHttpAuthMode[];

type MissingAuthMode = Exclude<
  PluginHttpAuthMode,
  (typeof HTTP_AUTH_MODES)[number]
>;
const _assertAllAuthModesListed: MissingAuthMode extends never ? true : never =
  true;
void _assertAllAuthModesListed;

const THREAD_EVENT_PAYLOAD_FIELDS = {
  "thread.created": ["thread"],
  "thread.active": ["thread"],
  "thread.idle": ["thread", "lastAssistantText"],
  "thread.failed": ["thread", "error"],
  "thread.archived": ["thread"],
  "thread.deleted": ["thread"],
  "interaction.pending": ["thread", "interaction"],
  "message.queued": ["entry"],
  "message.dispatched": ["entry"],
  "turn.failed": [
    "threadId",
    "requestId",
    "turnId",
    "errorInfo",
    "inputAccepted",
    "rateLimits",
    "attemptNumber",
  ],
} as const satisfies {
  [E in keyof PluginThreadEventPayloads]: readonly (keyof PluginThreadEventPayloads[E])[];
};

type MissingThreadEventField = {
  [E in keyof PluginThreadEventPayloads]: Exclude<
    keyof PluginThreadEventPayloads[E],
    (typeof THREAD_EVENT_PAYLOAD_FIELDS)[E][number]
  >;
}[keyof PluginThreadEventPayloads];
const _assertAllThreadEventFieldsListed: MissingThreadEventField extends never
  ? true
  : never = true;
void _assertAllThreadEventFieldsListed;

type SlotPropsByName = {
  homepageSection: PluginHomepageSectionProps;
  settingsSection: PluginSettingsSectionProps;
  experimental_appOverlay: ExperimentalAppOverlayProps;
  navPanel: PluginNavPanelProps;
  threadPanelAction: PluginThreadPanelProps;
  experimental_newThreadPanelAction: PluginNewThreadPanelProps;
  pendingInteraction: PluginPendingInteractionProps;
  sidebarFooterAction: PluginSidebarFooterActionProps;
  experimental_sidebarNavigation: ExperimentalSidebarNavigationProps;
  experimental_threadList: PluginThreadListProps;
  experimental_threadHeaderAction: PluginThreadHeaderActionProps;
  fileOpener: PluginFileOpenerProps;
  experimental_sourceCodeRenderer: PluginSourceCodeRendererProps;
  experimental_diffRenderer: PluginDiffRendererProps;
  messageDirective: PluginMessageDirectiveProps;
  messageAction: PluginMessageActionContext;
  commandPaletteAction: PluginCommandPaletteActionContext;
  experimental_providerIcon: PluginProviderIconRegistration;
  experimental_timelineRenderer: PluginTimelineRendererProps;
};

type MissingSlot = Exclude<keyof PluginAppSlots, keyof SlotPropsByName>;
const _assertAllSlotsListed: MissingSlot extends never ? true : never = true;
void _assertAllSlotsListed;

const APP_BUILDER_FIELDS = [
  "slots",
  "composer",
  "contentScripts",
  "experimental_sidebarFooter",
] as const satisfies readonly (keyof PluginAppBuilder)[];

type MissingAppBuilderField = Exclude<
  keyof PluginAppBuilder,
  (typeof APP_BUILDER_FIELDS)[number]
>;
const _assertAllAppBuilderFieldsListed: MissingAppBuilderField extends never
  ? true
  : never = true;
void _assertAllAppBuilderFieldsListed;

const CONTENT_SCRIPT_CONTEXT_FIELDS = [
  "pluginId",
  "generation",
  "signal",
  "experimental_setThreadRowStatus",
] as const satisfies readonly (keyof PluginContentScriptContext)[];

type MissingContentScriptContextField = Exclude<
  keyof PluginContentScriptContext,
  (typeof CONTENT_SCRIPT_CONTEXT_FIELDS)[number]
>;
const _assertAllContentScriptContextFieldsListed: MissingContentScriptContextField extends never
  ? true
  : never = true;
void _assertAllContentScriptContextFieldsListed;

const CONTENT_SCRIPT_REGISTRATION_FIELDS = [
  "id",
  "mount",
] as const satisfies readonly (keyof PluginContentScriptRegistration)[];

type MissingContentScriptRegistrationField = Exclude<
  keyof PluginContentScriptRegistration,
  (typeof CONTENT_SCRIPT_REGISTRATION_FIELDS)[number]
>;
const _assertAllContentScriptRegistrationFieldsListed: MissingContentScriptRegistrationField extends never
  ? true
  : never = true;
void _assertAllContentScriptRegistrationFieldsListed;

const FRONTEND_SLOT_PROP_FIELDS = {
  homepageSection: ["projectId"],
  settingsSection: [],
  experimental_appOverlay: [],
  navPanel: ["subPath"],
  threadPanelAction: ["threadId", "params"],
  experimental_newThreadPanelAction: ["projectId", "params"],
  pendingInteraction: ["interaction", "submit", "cancel"],
  sidebarFooterAction: [],
  experimental_sidebarNavigation: [
    "items",
    "activeItemId",
    "isCompactViewport",
    "experimental_activate",
    "experimental_Original",
  ],
  experimental_threadList: [
    "activeThreadId",
    "activeProjectId",
    "isCompactViewport",
    "onNavigate",
    "searchQuery",
    "Original",
    "experimental_Original",
  ],
  experimental_threadHeaderAction: [
    "threadId",
    "projectId",
    "isCompactViewport",
  ],
  fileOpener: ["path", "source", "Original", "experimental_Original"],
  experimental_sourceCodeRenderer: [
    "content",
    "path",
    "overflow",
    "highlightedLines",
    "Original",
    "experimental_Original",
  ],
  experimental_diffRenderer: [
    "patch",
    "path",
    "view",
    "overflow",
    "showLineNumbers",
    "experimental_fullFileContents",
    "Original",
    "experimental_Original",
  ],
  messageDirective: ["attributes", "source", "message", "openWorkspaceFile"],
  messageAction: ["threadId", "message", "selectedText", "openPanel"],
  commandPaletteAction: ["threadId", "projectId", "openPanel"],
  experimental_providerIcon: ["providerId", "icon"],
  experimental_timelineRenderer: [
    "row",
    "payload",
    "presentation",
    "thread",
    "Original",
  ],
} as const satisfies {
  [S in keyof SlotPropsByName]: readonly (keyof SlotPropsByName[S])[];
};

type MissingSlotPropField = {
  [S in keyof SlotPropsByName]: Exclude<
    keyof SlotPropsByName[S],
    (typeof FRONTEND_SLOT_PROP_FIELDS)[S][number]
  >;
}[keyof SlotPropsByName];
const _assertAllSlotPropFieldsListed: MissingSlotPropField extends never
  ? true
  : never = true;
void _assertAllSlotPropFieldsListed;

const NAV_PANEL_REGISTRATION_FIELDS = [
  "id",
  "title",
  "icon",
  "path",
  "component",
  "fixedTabs",
  "experimental_sidebarAccessory",
  "headerContent",
] as const satisfies readonly (keyof PluginNavPanelRegistration)[];

type MissingNavPanelRegistrationField = Exclude<
  keyof PluginNavPanelRegistration,
  (typeof NAV_PANEL_REGISTRATION_FIELDS)[number]
>;
const _assertAllNavPanelRegistrationFieldsListed: MissingNavPanelRegistrationField extends never
  ? true
  : never = true;
void _assertAllNavPanelRegistrationFieldsListed;

const SIDEBAR_FOOTER_ACTION_REGISTRATION_FIELDS = [
  "id",
  "title",
  "icon",
  "run",
] as const satisfies readonly (keyof PluginSidebarFooterActionRegistration)[];

type MissingSidebarFooterActionRegistrationField = Exclude<
  keyof PluginSidebarFooterActionRegistration,
  (typeof SIDEBAR_FOOTER_ACTION_REGISTRATION_FIELDS)[number]
>;
const _assertAllSidebarFooterActionRegistrationFieldsListed: MissingSidebarFooterActionRegistrationField extends never
  ? true
  : never = true;
void _assertAllSidebarFooterActionRegistrationFieldsListed;

const MESSAGE_ACTION_REGISTRATION_FIELDS = [
  "id",
  "title",
  "icon",
  "run",
] as const satisfies readonly (keyof PluginMessageActionRegistration)[];

type MissingMessageActionRegistrationField = Exclude<
  keyof PluginMessageActionRegistration,
  (typeof MESSAGE_ACTION_REGISTRATION_FIELDS)[number]
>;
const _assertAllMessageActionRegistrationFieldsListed: MissingMessageActionRegistrationField extends never
  ? true
  : never = true;
void _assertAllMessageActionRegistrationFieldsListed;

const COMMAND_PALETTE_ACTION_REGISTRATION_FIELDS = [
  "id",
  "title",
  "isAvailable",
  "run",
] as const satisfies readonly (keyof PluginCommandPaletteActionRegistration)[];

type MissingCommandPaletteActionRegistrationField = Exclude<
  keyof PluginCommandPaletteActionRegistration,
  (typeof COMMAND_PALETTE_ACTION_REGISTRATION_FIELDS)[number]
>;
const _assertAllCommandPaletteActionRegistrationFieldsListed: MissingCommandPaletteActionRegistrationField extends never
  ? true
  : never = true;
void _assertAllCommandPaletteActionRegistrationFieldsListed;

const THREAD_CHAT_PROP_FIELDS = [
  "threadId",
  "variant",
  "layout",
  "focusRequest",
  "permissionPolicy",
  "className",
  "leadingContent",
  "messageActions",
] as const satisfies readonly (keyof ThreadChatProps)[];

type MissingThreadChatPropField = Exclude<
  keyof ThreadChatProps,
  (typeof THREAD_CHAT_PROP_FIELDS)[number]
>;
const _assertAllThreadChatPropFieldsListed: MissingThreadChatPropField extends never
  ? true
  : never = true;
void _assertAllThreadChatPropFieldsListed;

const THREAD_CHAT_MESSAGE_ACTION_FIELDS = [
  "id",
  "title",
  "icon",
  "roles",
  "run",
] as const satisfies readonly (keyof ThreadChatMessageAction)[];

type MissingThreadChatMessageActionField = Exclude<
  keyof ThreadChatMessageAction,
  (typeof THREAD_CHAT_MESSAGE_ACTION_FIELDS)[number]
>;
const _assertAllThreadChatMessageActionFieldsListed: MissingThreadChatMessageActionField extends never
  ? true
  : never = true;
void _assertAllThreadChatMessageActionFieldsListed;

describe("bb-plugin-authoring skill", () => {
  const skillEntry = readFileSync(SKILL_PATH, "utf8");
  const skill = readSkillTree();

  it("has frontmatter naming the skill after its directory", () => {
    expect(skillEntry).toMatch(/^---\nname: bb-plugin-authoring\n/);
  });

  it("documents every BbPluginApi property", () => {
    for (const key of BB_PLUGIN_API_KEYS) {
      expect(skill, `bb.${key} is not documented in the skill`).toContain(
        `bb.${key}`,
      );
    }
  });

  it("documents every @get-bb/plugin-sdk/app runtime export", () => {
    for (const name of FRONTEND_RUNTIME_EXPORT_NAMES) {
      expect(skill, `${name} is not documented in the skill`).toContain(name);
    }
  });

  it("accounts for every @get-bb/plugin-sdk/app type export", () => {
    for (const name of FRONTEND_TYPE_EXPORT_NAMES) {
      expect(skill, `${name} is not documented in the skill`).toContain(name);
    }
  });

  it("accounts for every frontend testing export", () => {
    for (const name of FRONTEND_TEST_EXPORT_NAMES) {
      expect(skill, `${name} is not documented in the skill`).toContain(name);
    }
  });

  it("accounts for every public backend and provider entrypoint export", () => {
    for (const name of PUBLIC_PLUGIN_SDK_EXPORT_NAMES) {
      expect(skill, `${name} is not documented in the skill`).toContain(name);
    }
  });

  it("keeps fake-host and distribution examples aligned with implementation", () => {
    const testing = readReference("testing.md");
    const quickstart = readReference("quickstart.md");
    const distribution = readReference("distribution.md");

    expect(testing).toContain(
      "experimental_callHostRpc: async ({ method, input, hostId, signal })",
    );
    expect(testing).toContain('const body = JSON.stringify({ event: "test" })');
    expect(testing).toMatch(
      /experimental_emitHostSignal\(\s*"host-test",\s*"changed",\s*\{\s*reason: "test",?\s*\}/,
    );
    expect(testing).not.toContain("resolveAgentConfiguration(context)");
    expect(quickstart).toContain("server.js.map");
    expect(quickstart).toContain("--omit=dev --omit=optional");
    expect(distribution).not.toMatch(/"engines"\s*:/);
  });

  it("documents the complete frontend content-script lifecycle contract", () => {
    for (const field of APP_BUILDER_FIELDS) {
      expect(skill, `PluginAppBuilder.${field} is not documented`).toContain(
        field,
      );
    }
    for (const field of CONTENT_SCRIPT_CONTEXT_FIELDS) {
      expect(
        skill,
        `content-script context.${field} is not documented`,
      ).toContain(field);
    }
    for (const field of CONTENT_SCRIPT_REGISTRATION_FIELDS) {
      expect(
        skill,
        `content-script registration.${field} is not documented`,
      ).toContain(field);
    }
    expect(skill).toContain("not a security sandbox");
    expect(skill).toContain("reverse registration order");
  });

  it("documents every settings descriptor type", () => {
    for (const type of SETTING_DESCRIPTOR_TYPES) {
      expect(
        skill,
        `settings descriptor type "${type}" is not documented in the skill`,
      ).toContain(`type: "${type}"`);
    }
  });

  it("documents every http auth mode", () => {
    for (const mode of HTTP_AUTH_MODES) {
      expect(
        skill,
        `http auth mode "${mode}" is not documented in the skill`,
      ).toContain(`"${mode}"`);
    }
  });

  it("documents every thread event and its payload fields", () => {
    for (const [event, fields] of Object.entries(THREAD_EVENT_PAYLOAD_FIELDS)) {
      expect(skill, `${event} is not documented in the skill`).toContain(
        `"${event}"`,
      );
      for (const field of fields) {
        expect(
          skill,
          `${event} payload field "${field}" is not documented in the skill`,
        ).toContain(field);
      }
    }
  });

  it("documents every navPanel registration field", () => {
    for (const field of NAV_PANEL_REGISTRATION_FIELDS) {
      expect(
        skill,
        `navPanel registration field "${field}" is not documented in the skill`,
      ).toContain(field);
    }
  });

  it("documents every sidebarFooterAction registration field", () => {
    for (const field of SIDEBAR_FOOTER_ACTION_REGISTRATION_FIELDS) {
      expect(
        skill,
        `sidebarFooterAction registration field "${field}" is not documented in the skill`,
      ).toContain(field);
    }
    expect(skill).toContain("openSettings");
  });

  it("documents every messageAction registration field", () => {
    for (const field of MESSAGE_ACTION_REGISTRATION_FIELDS) {
      expect(
        skill,
        `messageAction registration field "${field}" is not documented in the skill`,
      ).toContain(field);
    }
    expect(skill).toContain("sourceSeqEnd");
  });

  it("documents every commandPaletteAction registration field", () => {
    for (const field of COMMAND_PALETTE_ACTION_REGISTRATION_FIELDS) {
      expect(
        skill,
        `commandPaletteAction registration field "${field}" is not documented in the skill`,
      ).toContain(field);
    }
  });

  it("documents every ThreadChat prop", () => {
    for (const field of THREAD_CHAT_PROP_FIELDS) {
      expect(
        skill,
        `ThreadChat prop "${field}" is not documented in the skill`,
      ).toContain(field);
    }
  });

  it("documents every ThreadChat message-action field", () => {
    expect(skill).toContain("ThreadChatMessageAction");
    for (const field of THREAD_CHAT_MESSAGE_ACTION_FIELDS) {
      expect(
        skill,
        `ThreadChatMessageAction field "${field}" is not documented in the skill`,
      ).toContain(field);
    }
  });

  it("documents the explicit plugin branding contract", () => {
    expect(skill).toContain("bb.name");
    expect(skill).toContain("bb.description");
    expect(skill).toContain("bb.branding");
    expect(skill).toContain("logo.light");
    expect(skill).toContain("logo.dark");
    expect(skill).toContain("no root logo auto-detection");
    expect(skill).toContain("currentColor");
    expect(skill).toContain("branding.icon");
    expect(skill).toContain("./assets/icon.svg");
    expect(skill).toContain("CSS mask");
    expect(skill).toContain("canonical BB icon name");
    expect(skill).toContain("BB reuses this icon on roomy");
    expect(skill).toContain("Logo-only");
    expect(skill).toContain("manifests remain supported");
    expect(skill).toContain("Do not duplicate");
  });

  it("documents every frontend slot and its prop fields", () => {
    for (const [slot, fields] of Object.entries(FRONTEND_SLOT_PROP_FIELDS)) {
      expect(skill, `slot ${slot} is not documented in the skill`).toContain(
        slot,
      );
      for (const field of fields) {
        expect(
          skill,
          `slot ${slot} prop field "${field}" is not documented in the skill`,
        ).toContain(field);
      }
    }
  });
});
