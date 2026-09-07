import type { PluginHostArtifactSnapshot } from "./plugin-service-internal.js";

export class PluginHostArtifactRegistry {
  readonly #byPluginId = new Map<string, PluginHostArtifactSnapshot>();

  set(pluginId: string, artifact: PluginHostArtifactSnapshot): void {
    this.#byPluginId.set(pluginId, artifact);
  }

  delete(pluginId: string): void {
    this.#byPluginId.delete(pluginId);
  }

  get(pluginId: string): PluginHostArtifactSnapshot | undefined {
    return this.#byPluginId.get(pluginId);
  }

  entries(): IterableIterator<[string, PluginHostArtifactSnapshot]> {
    return this.#byPluginId.entries();
  }
}
