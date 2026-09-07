export interface PublishedMigrationWhen {
  tag: string;
  when: number;
}

export interface CompatibleMigrationHash {
  hash: string;
  tag: string;
  when: number;
}

export const publishedMigrationWhens = [
  { tag: "0000_baseline", when: 1778891867195 },
  { tag: "0001_terminal_session_user_input", when: 1779139400000 },
  { tag: "0002_closed_session_prune_indexes", when: 1779139400001 },
] as const satisfies readonly PublishedMigrationWhen[];

export const compatibleMigrationHashes = [
  {
    tag: "0031_mysterious_zaran",
    when: 1781403656069,
    hash: "bc111f5134183c37cf135af70231ec5a79823f9868818fdd8377e1ab3c05a23f",
  },
  {
    tag: "0039_thread_search",
    when: 1781660000001,
    hash: "025358fe89253aec7f5bd970dc3eb88d0e834f0d58fb9d75329a5d39899340f4",
  },
  {
    tag: "0103_wandering_mongoose",
    when: 1787181956957,
    hash: "79d39e7b68d1db8ba02614fe4cc227cc0c154d77c7183f2e37ed2d8475412993",
  },
  {
    tag: "0111_known_morph",
    when: 1788219579088,
    hash: "eda4daf7f011d8718c21d3fbd71030f30438863cd1e6ceddd32a5052fb3a14cd",
  },
] as const satisfies readonly CompatibleMigrationHash[];

export const publishedMigrationWhensByTag: ReadonlyMap<string, number> =
  new Map(publishedMigrationWhens.map((entry) => [entry.tag, entry.when]));
