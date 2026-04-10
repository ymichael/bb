export interface GetOrCreateScopedItemIdArgs {
  createItemId: () => string;
  openItemIdsByScope: Map<string, string>;
  parentToolCallId?: string;
  scopeId: string;
}

export interface ResolveCompletedScopedItemIdArgs {
  createItemId: () => string;
  openItemIdsByScope: Map<string, string>;
  parentToolCallId?: string;
  providerItemId?: string;
  scopeId: string;
}

function toScopedItemKey(
  parentToolCallId: string | undefined,
  scopeId: string,
): string {
  return `${parentToolCallId ?? "root"}:${scopeId}`;
}

export function getOrCreateScopedItemId(
  args: GetOrCreateScopedItemIdArgs,
): string {
  const scopeKey = toScopedItemKey(args.parentToolCallId, args.scopeId);
  const existing = args.openItemIdsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }

  const itemId = args.createItemId();
  args.openItemIdsByScope.set(scopeKey, itemId);
  return itemId;
}

export function resolveCompletedScopedItemId(
  args: ResolveCompletedScopedItemIdArgs,
): string {
  const scopeKey = toScopedItemKey(args.parentToolCallId, args.scopeId);
  const existing = args.openItemIdsByScope.get(scopeKey);
  if (existing) {
    args.openItemIdsByScope.delete(scopeKey);
    return existing;
  }

  return args.providerItemId ?? args.createItemId();
}
