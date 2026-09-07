import { fuzzyMatchText } from "@bb/fuzzy-match";

interface SearchPickerOptionsArgs<T> {
  options: readonly T[];
  query: string;
  getLabel: (option: T) => string;
  getAliases?: (option: T) => readonly string[];
}

export function searchPickerOptions<T>({
  options,
  query,
  getLabel,
  getAliases,
}: SearchPickerOptionsArgs<T>): readonly T[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return options;
  }

  return fuzzyMatchText({
    items: options,
    query: normalizedQuery,
    getText: getLabel,
    getAliases: (option) => getAliases?.(option) ?? [],
    limit: options.length,
  }).map((match) => match.item);
}
