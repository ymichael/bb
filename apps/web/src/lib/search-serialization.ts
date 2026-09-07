import { defaultStringifySearch } from "@tanstack/react-router";

export function stringifySiteSearch(search: Record<string, unknown>): string {
  const rest = { ...search };
  const category = rest.category;
  delete rest.category;
  const params = new URLSearchParams(defaultStringifySearch(rest));
  if (typeof category === "string") params.set("category", category);
  const encoded = params.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
}
