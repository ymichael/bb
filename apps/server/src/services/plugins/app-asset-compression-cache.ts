interface CachedAppAssetEncodings {
  hash: string;
  variants: Map<string, Promise<Buffer>>;
}

export interface AppAssetCompressionCache {
  getOrCreate(args: {
    assetKey: string;
    compress: () => Promise<Buffer>;
    encoding: string;
    hash: string;
  }): Promise<Buffer>;
}

export function createAppAssetCompressionCache(
  maxEntries: number,
): AppAssetCompressionCache {
  const entries = new Map<string, CachedAppAssetEncodings>();

  return {
    getOrCreate(args) {
      let entry = entries.get(args.assetKey);
      if (entry === undefined || entry.hash !== args.hash) {
        entry = { hash: args.hash, variants: new Map() };
        entries.set(args.assetKey, entry);
      } else {
        entries.delete(args.assetKey);
        entries.set(args.assetKey, entry);
      }

      const cached = entry.variants.get(args.encoding);
      if (cached !== undefined) {
        return cached;
      }

      let compression: Promise<Buffer>;
      compression = args.compress().catch((error: unknown) => {
        if (entry.variants.get(args.encoding) === compression) {
          entry.variants.delete(args.encoding);
        }
        throw error;
      });
      entry.variants.set(args.encoding, compression);

      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        entries.delete(oldestKey);
      }
      return compression;
    },
  };
}
