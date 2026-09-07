import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CLAUDE_CODE_ACTIVE_CATALOG_DATA,
  CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "./src/model-catalog-data.js";
import { CLAUDE_NATIVE_ROOTS_DECLARATION } from "./src/native-roots.js";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    memoryEnabled: {
      type: "boolean",
      label: "Claude Code memory",
      description:
        "Allow Claude Code to read and write its native auto-memory for bb threads.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Hide Claude Code's native Task tool so agents use bb for delegation.",
      default: false,
    },
    workflowsDisabled: {
      type: "boolean",
      label: "Disable Workflow tool",
      description: "Hide Claude Code's native Workflow tool for bb threads.",
      default: false,
    },
    idleQueryReleaseEnabled: {
      type: "boolean",
      label: "Release idle Claude processes",
      description:
        "Close a quiescent Claude Code process after 30 seconds and resume it on the next turn.",
      default: false,
    },
    chromeEnabled: {
      type: "boolean",
      label: "Claude in Chrome",
      description:
        "Start Claude Code with the Claude in Chrome browser tools. Needs the Chrome extension and a claude.ai login on the host.",
      default: false,
    },
  });

  bb.providers.register({
    id: "claude-code",
    displayName: "Claude Code",
    icon: "./icons/claude-code.svg",
    strings: {
      signInHint: "Run `claude` on the machine to sign in.",
      expiredHint: "Your Claude session expired. Run `claude`, then reload.",
      installUrl: "https://claude.com/claude-code",
      brandPrefix: "Claude ",
      planModeCopy:
        "Claude Code will plan without normal full-access execution.",
      iconTint: { light: "#D97757", dark: "#D97757" },
    },
    ...CLAUDE_NATIVE_ROOTS_DECLARATION,
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "ultracode", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      {
        id: "ultracode",
        label: "Ultracode",
        description: "Extra-high effort plus standing workflow orchestration.",
      },
      { id: "max", label: "Max" },
    ],
    composerActions: ["plan"],
    env: { passthrough: ["BB_CLAUDE_CODE_EXECUTABLE"] },
    models: {
      scope: "host",
      fallback: CLAUDE_CODE_ACTIVE_CATALOG_DATA.map((entry) => ({
        id: entry.model,
        displayName: entry.displayName,
        description: entry.description,
        supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        isDefault: entry.model === DEFAULT_CLAUDE_CODE_MODEL,
      })),
    },
    deriveProviderOptions(context) {
      return {
        memoryEnabled: context.settings.memoryEnabled !== false,
        providerSubagentsEnabled: context.settings.subagentsDisabled !== true,
        workflowsEnabled: context.settings.workflowsDisabled !== true,
        idleQueryReleaseEnabled:
          context.settings.idleQueryReleaseEnabled === true,
        chromeEnabled: context.settings.chromeEnabled === true,
        ...(context.promptMode === "plan"
          ? { claudeCodePermissionMode: "plan" }
          : {}),
      };
    },
  });
}
