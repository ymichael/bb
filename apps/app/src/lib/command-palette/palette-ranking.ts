import { fuzzyMatchText } from "@bb/fuzzy-match";
import type { PaletteAction } from "./palette-action";

export const PALETTE_RESULT_LIMIT = 50;

export interface RankedPaletteAction {
  action: PaletteAction;
  positions: readonly number[];
}

export interface RankPaletteActionsArgs {
  actions: readonly PaletteAction[];
  query: string;
  recentIds: readonly string[];
}

function titleMatchPositions(title: string, query: string): number[] {
  const positions: number[] = [];
  const haystack = title.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  for (const character of needle) {
    if (character === " ") continue;
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return [];
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

export function rankPaletteActions(
  args: RankPaletteActionsArgs,
): RankedPaletteAction[] {
  const buildOrder = new Map(
    args.actions.map((action, index) => [action.id, index]),
  );
  const recentRank = new Map(
    args.recentIds.map((id, index) => [id, index] as const),
  );
  const rankOf = (action: PaletteAction) =>
    recentRank.get(action.id) ?? Number.MAX_SAFE_INTEGER;
  const orderOf = (action: PaletteAction) => buildOrder.get(action.id) ?? 0;

  if (args.query.trim() === "") {
    return [...args.actions]
      .sort(
        (left, right) =>
          rankOf(left) - rankOf(right) || orderOf(left) - orderOf(right),
      )
      .slice(0, PALETTE_RESULT_LIMIT)
      .map((action) => ({ action, positions: [] }));
  }

  const matches = fuzzyMatchText({
    items: args.actions,
    query: args.query,
    getText: (action) => action.title,
    getAliases: (action) => [action.group],
    limit: PALETTE_RESULT_LIMIT,
  });

  return [...matches]
    .sort(
      (left, right) =>
        right.score - left.score ||
        rankOf(left.item) - rankOf(right.item) ||
        orderOf(left.item) - orderOf(right.item),
    )
    .map((match) => ({
      action: match.item,
      positions: titleMatchPositions(match.item.title, args.query),
    }));
}
