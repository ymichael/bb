import type { PluginHookHandler, PluginHookName } from "@get-bb/plugin-sdk";

/** One plugin's handler for one hook. */
export interface PluginHookRegistration<K extends PluginHookName> {
  pluginId: string;
  handler: PluginHookHandler<K>;
}

/** What one wrapped hook invocation returned, or why it did not. */
export type PluginHookInvocation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Everything the hook runner needs from the plugin service. It is an
 * interface rather than a direct import because the runner runs on the
 * thread-dispatch hot path, which is assembled long before the plugin service
 * exists — the same reason `plugin-thread-events.ts` bridges the lifecycle
 * seams — and because it is the seam a test substitutes fake handlers through.
 */
export interface PluginHookProvider {
  /** Registered handlers for a hook, in plugin install order. */
  listHooks<K extends PluginHookName>(hook: K): PluginHookRegistration<K>[];
  /**
   * Runs one handler through the plugin service's failure isolation (handler
   * stats, plugin status detail, plugin log), so a handler that throws is as
   * visible as any other misbehaving handler even though the runner then
   * fails the dispatch on top of that.
   */
  invokeHook<T>(
    pluginId: string,
    label: string,
    run: () => Promise<T>,
  ): Promise<PluginHookInvocation<T>>;
  /** Per-handler decision box in milliseconds. */
  readonly decisionTimeoutMs: number;
}

/**
 * Module-level bridge, registered once by createApp exactly like
 * {@link setPluginThreadEventEmitter}. Unset — every isolated thread test that
 * never builds an app — there are no hooks at all, which is precisely the
 * zero-overhead path: the runner returns without taking its lock.
 */
let provider: PluginHookProvider | undefined;

export function setPluginHookProvider(next: PluginHookProvider | undefined): void {
  provider = next;
}

export function pluginHookProvider(): PluginHookProvider | undefined {
  return provider;
}
