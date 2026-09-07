import type { PluginSdkApp } from "./app-contract.js";

export type * from "./app-contract.js";
export type * from "./json-value.js";
export type {
  PluginRpcCallArgs,
  PluginRpcContract,
  PluginRpcError,
  PluginRpcErrorCode,
  PluginRpcHandlers,
  PluginRpcIssuePathSegment,
  PluginRpcMethodContract,
  PluginRpcResult,
  PluginRpcValidationIssue,
  StandardSchemaV1,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./rpc-contract.js";

/**
 * `@get-bb/plugin-sdk/app` — typed facade over the BB app's plugin runtime.
 *
 * This module's runtime is never bundled into plugins: `bb plugin build`
 * swaps the specifier for a shim reading
 * `globalThis.__bbPluginRuntime.pluginSdkApp` (which the BB app fills with
 * its real implementation before importing any plugin bundle). The re-export
 * below mirrors that shim so code importing this package directly (plugin
 * unit tests, tooling) resolves the same objects when a runtime is
 * installed — and `undefined` values, not a module-load throw, when none is.
 *
 * Hooks-only surface (the host-provided UI kit was removed 2026-07-03,
 * plugin design §5.5): components are vendored shadcn-style source from the
 * BB registry (`npx shadcn add @bb/<name>`); `toast` comes from
 * `import { toast } from "sonner"` (runtime-shimmed to the host toaster).
 */

interface PluginRuntimeHost {
  __bbPluginRuntime?: { pluginSdkApp?: unknown };
}

// The global is the genuinely unknowable boundary here: the host app
// guarantees the shape via its own `satisfies PluginSdkApp` check.
const runtime = ((globalThis as PluginRuntimeHost).__bbPluginRuntime
  ?.pluginSdkApp ?? {}) as Partial<PluginSdkApp> as PluginSdkApp;

export const definePluginApp = runtime.definePluginApp;
export const ThreadChat = runtime.ThreadChat;
export const Markdown = runtime.Markdown;
export const experimental_FileLink = runtime.experimental_FileLink;
export const UrlLink = runtime.UrlLink;
export const experimental_NewThreadComposer =
  runtime.experimental_NewThreadComposer;
export const experimental_ProviderModelPicker =
  runtime.experimental_ProviderModelPicker;
export const experimental_PermissionModePicker =
  runtime.experimental_PermissionModePicker;
export const experimental_BranchPicker = runtime.experimental_BranchPicker;
export const experimental_useBranches = runtime.experimental_useBranches;
export const experimental_useCheckoutState =
  runtime.experimental_useCheckoutState;
// Host-owned code rendering (experimental — see docs/api_to_audit.md).
export const experimental_SourceCode = runtime.experimental_SourceCode;
export const experimental_Diff = runtime.experimental_Diff;
export const useRpc = runtime.useRpc;
export const useRealtime = runtime.useRealtime;
export const useRealtimeConnectionState = runtime.useRealtimeConnectionState;
export const useSettings = runtime.useSettings;
export const useBbContext = runtime.useBbContext;
export const useBbNavigate = runtime.useBbNavigate;
export const experimental_useAppPanel = runtime.experimental_useAppPanel;
export const experimental_useFixedTabTarget =
  runtime.experimental_useFixedTabTarget;
export const useComposer = runtime.useComposer;
export const useComposerView = runtime.useComposerView;
// Sidebar surfaces for plugins that replace the thread list (experimental —
// see docs/api_to_audit.md).
export const experimental_useSidebarThreads =
  runtime.experimental_useSidebarThreads;
export const experimental_useSidebarThreadActions =
  runtime.experimental_useSidebarThreadActions;
export const experimental_useSidebarThreadPullRequest =
  runtime.experimental_useSidebarThreadPullRequest;
export const experimental_useSidebarThreadSplit =
  runtime.experimental_useSidebarThreadSplit;
// The provider directory (experimental — see docs/api_to_audit.md).
export const experimental_useProviders = runtime.experimental_useProviders;
// The live code theme, for plugins that render code with their own engine
// (experimental — see docs/api_to_audit.md).
export const experimental_useCodeTheme = runtime.experimental_useCodeTheme;
